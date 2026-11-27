import { computerOfSection, type SettingsPageId } from "../settings";
import { nameInLine } from "../hostWords";
import { listPages, type ListGroup, type ListRow } from "./list";
import { SETTINGS_MAP, settingWords, type SettingEntry, type SettingPage, type SettingVars } from "./map";

/**
 * Search over all of Settings (docs/agents/settings.md "Search"): every page of this window's list and every row of
 * the map on one of them, found by its name or by a name it had before Settings 2 ("Hosts", "Harness config"), which
 * the result then says ("Was “Hosts › Sync › Harness config”"). A row that exists once per computer, job or workspace
 * is listed once for each, which shows its scope.
 */
export type SearchResult = {
  key: string;
  title: string;
  /** "Group, Page, Section": where it is. */
  path: string;
  /** Its old name, only when that is what matched. */
  was?: string;
  page: SettingsPageId;
  /** The row to scroll to; none for a page's own result. */
  row?: string;
  /** The computer a row drawn once per computer is about (its environment id): a row in its sheet opens the sheet. */
  computer?: string;
  /** A press, not a page: "Add a computer…" opens its dialog. */
  act?: "add-computer";
};

/** What pages were called, for a search by an old page name. */
export const PAGE_WAS: Partial<Record<SettingPage, readonly string[]>> = {
  keybindings: ["Keybindings"],
  updates: ["General › About", "Hosts › Release › Code updates"],
  here: ["Hosts › Running threads, Stuck after, Attachment limit", "Providers"],
  sharing: ["Hosts › Clients, Mac bridge, Remote access", "Environments"],
  publish: ["Hosts › Release"],
  defaults: ["Thread defaults"],
  orchestration: ["Orchestration"],
  sync: ["Hosts › Sync"],
  accounts: ["Accounts"],
  // Another computer's page was its own section of Hosts, said by its name ("Hosts › The box") in the index.
  winvm: ["Work › Windows VM"],
  digest: ["Work › Digest"],
  mail: ["Work › Mail"],
  files: ["Work › Folders", "Work › Guest links", "Work › Word files"],
};

/** Names that live outside the map: add-ons and skills by name, each opening its page. */
export type SearchExtra = {
  title: string;
  page: SettingsPageId;
  path: string;
  /** What it was called, for a search by an old name. */
  was?: readonly string[];
  /** A press that opens a dialog in place of a row: "Add a computer…". */
  act?: "add-computer";
};

/** "Add a computer…", the press at the foot of Other computers, found by its own name and by Hosts' "Add host". */
export const ADD_COMPUTER_RESULT: SearchExtra = { title: "Add a computer…", page: "sharing", path: "Other computers", was: ["Hosts › Add host"], act: "add-computer" };

/** Connections' sign-ins by name, each opening that page: its rows are per computer and per service, read live. */
export const SIGN_IN_NAMES: readonly SearchExtra[] = ["LifeOS", "Office", "Google"].map((service) => ({
  title: `${service} sign-in`,
  page: "connections",
  path: "Work, Connections",
}));

export const SEARCH_LIMIT = 40;

/** `counted`: a row whose page names it with a count the index cannot know: a typed number does not have to match. */
type Indexed = SearchResult & { names: string; old: readonly string[]; rank: number; counted?: boolean };

const pageKind = (row: ListRow): SettingPage => (row.kind === "computer" ? "computer:*" : row.kind === "job" ? "job" : row.kind === "workspace" ? "workspace" : (row.id as SettingPage));

/** A path's parts without a part said twice running (the Work page in the Work group). */
const pathOf = (...parts: (string | undefined)[]): string => parts.filter((part, i, all): part is string => !!part && part !== all[i - 1]).join(", ");

/** The other computers a per-computer row on a shared page is drawn for. */
const computersOf = (groups: readonly ListGroup[]): ListRow[] => listPages(groups).flatMap(({ row }) => (row.kind === "computer" ? [row] : []));

/** What this window is, for rows a page draws only in some windows (`SettingEntry.needs`). */
/** `workHere`: Work is on for this window's own computer (the capture key is that computer's). */
/** `jobsOn`: the computers (environment ids) with Work on that hold a job, whose pages list their jobs. */
/** `workCount`: how many linked computers have Work on; `placesDiffer`: a place may keep its own start set (New
 *  threads draws its overrides row). */
export type SearchWindow = { web?: boolean; mac?: boolean; work?: boolean; workHere?: boolean; jobsOn?: readonly string[]; workCount?: number; placesDiffer?: boolean; reviewsDiffer?: boolean };

const drawn = (entry: SettingEntry, window: SearchWindow): boolean =>
  !entry.needs || entry.needs.every((need) =>
    need === "desktop"
      ? !window.web
      : need === "mac"
        ? window.mac !== false
        : need === "workHere"
          ? (window.workHere ?? window.work) !== false
          : need === "workMany"
            ? (window.workCount ?? 2) > 1
            : need === "placesDiffer"
              ? window.placesDiffer !== false
              : need === "reviewsDiffer"
                ? window.reviewsDiffer === true
                : window.work !== false,
  );

function index(groups: readonly ListGroup[], vars: SettingVars, extras: readonly SearchExtra[], window: SearchWindow): Indexed[] {
  const out: Indexed[] = [];
  const computers = computersOf(groups);
  for (const { row, group } of listPages(groups)) {
    const kind = pageKind(row);
    // A page is found by its row's label and by its own title, and a result says the title ("Threads on this Mac").
    const title = row.title ?? row.label;
    out.push({ key: `page:${row.id}`, title, path: pathOf(group.label), page: row.id, names: `${title} ${row.label}`, old: kind === "computer:*" ? [`Hosts › ${row.label}`] : (PAGE_WAS[kind] ?? []), rank: 0 });
    // A computer, a job or a workspace is its own place: its rows say its name, not the heading it stands under.
    const place = row.kind === "page" ? group.label : undefined;
    const own: SettingVars = row.kind === "computer" ? { ...vars, computer: nameInLine(row.label) } : vars;
    for (const entry of SETTINGS_MAP) {
      if (entry.page !== kind || !drawn(entry, window)) continue;
      // A computer's page lists its jobs only where it has some.
      if (entry.id === "pc.jobs" && row.kind === "computer" && !window.jobsOn?.includes(computerOfSection(row.id) ?? "")) continue;
      // A row on a shared page that is drawn per computer ("The box on this Mac") lists once for each.
      const perComputer = row.kind !== "computer" && /\{computer\}/.test(entry.section + entry.title);
      if (!perComputer) out.push(rowResult(entry, row, place, own));
      else for (const computer of computers) out.push({ ...rowResult(entry, row, place, { ...vars, computer: nameInLine(computer.label) }), computer: computerOfSection(computer.id) ?? undefined });
    }
  }
  for (const extra of extras) out.push({ key: `extra:${extra.page}:${extra.title}`, title: extra.title, path: extra.path, page: extra.page, act: extra.act, names: extra.title, old: extra.was ?? [], rank: 1 });
  return out;
}

/** A row whose name holds a count the index cannot know, named for search as its page or dialog names it. */
const UNCOUNTED: Record<string, string> = {
  "defaults.different": "Different from New threads",
  "reviews.different": "Projects that differ from Reviews",
  "here.install": "Agent apps you can install",
  "pc.install": "Agent apps you can install",
};

function rowResult(entry: SettingEntry, row: ListRow, place: string | undefined, vars: SettingVars): Indexed {
  const uncounted = vars.n === undefined ? UNCOUNTED[entry.id] : undefined;
  const title = uncounted ?? settingWords(entry.title, vars);
  const section = entry.section ? settingWords(entry.section, vars) : undefined;
  return {
    key: `${row.id}:${entry.id}:${vars.computer ?? ""}`,
    title,
    // The group's own page (Work's Setup, titled Work) is said by the group alone.
    // A computer's section that names it ("Threads on the box") says the name once.
    // A page with a title of its own ("Threads on this Mac") is said by it, as a computer's section is ("Threads on the box").
    path: named(section, vars.computer)
      ? section!
      : row.title && row.title !== place
        ? pathOf(row.title, section === title ? undefined : section)
        : pathOf(place, place && row.title === place ? undefined : row.label, section === title ? undefined : section),
    page: row.id,
    row: entry.id,
    // A counted row is also found by its page's own words ("different in places").
    names: uncounted ? `${title} ${settingWords(entry.title, vars)}` : title,
    counted: uncounted !== undefined,
    // An old name says the computer a row was on ("Hosts › The box › Port"), never "a host".
    old: entry.was.map((was) => settingWords(was, vars)),
    rank: 1,
  };
}

const named = (section: string | undefined, computer: string | undefined): boolean => !!section && !!computer && section.toLowerCase().includes(computer.toLowerCase());

const has = (text: string, needles: readonly string[]): boolean => {
  const lower = text.toLowerCase();
  return needles.every((needle) => lower.includes(needle));
};

/**
 * Whether an old name answers what he typed. A row's old name starts with the page it was on ("Hosts › Sync ›
 * Harness config"): a row is found by it only when a typed word is in its own part, past the page, so "hosts" finds
 * the pages Hosts became and not every row that once stood on it, while "hosts sync" and "harness" still find the row.
 */
function hadName(old: string, needles: readonly string[], row: boolean): boolean {
  if (!has(old, needles)) return false;
  const own = old.includes(" › ") ? old.slice(old.indexOf(" › ")) : old;
  return !row || needles.some((needle) => own.toLowerCase().includes(needle));
}

/**
 * The results for what he typed: every typed word must be in the name, or all in one old name. A page's own name
 * comes first, then rows by name (a name that starts with what he typed before one that holds it), then what is found
 * by an old name alone. At most `SEARCH_LIMIT`.
 */
export function searchSettings(query: string, groups: readonly ListGroup[], vars: SettingVars = {}, extras: readonly SearchExtra[] = [], window: SearchWindow = {}): SearchResult[] {
  const needles = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!needles.length) return [];
  const typed = needles.join(" ");
  const scored: { result: SearchResult; score: number; at: number }[] = [];
  index(groups, vars, extras, window).forEach((item, at) => {
    const { names, old, rank, counted, ...result } = item;
    // "Different in 2 places" is found with its count typed, whatever the count is today.
    const wanted = counted ? needles.filter((needle) => !/^\d+$/.test(needle)) : needles;
    if (wanted.length && has(names, wanted)) {
      scored.push({ result, score: rank * 2 + (names.toLowerCase().startsWith(typed) ? 0 : 1), at });
      return;
    }
    // A press (Add a computer…) stands for a whole old page part, as a page does: "hosts" finds it.
    const was = old.find((name) => hadName(name, needles, rank > 0 && !result.act));
    // One mark for a place, as the line above it has: commas.
    if (was) scored.push({ result: { ...result, was: `Was “${was.replaceAll(" › ", ", ")}”` }, score: 4 + rank, at });
  });
  return scored
    .sort((a, b) => a.score - b.score || a.at - b.at)
    .slice(0, SEARCH_LIMIT)
    .map((item) => item.result);
}

/** The page a result opens is another computer's: its row in the list. */
export const isComputerResult = (result: SearchResult): boolean => computerOfSection(result.page) !== null;
