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
};

/** What pages were called, for a search by an old page name. */
export const PAGE_WAS: Partial<Record<SettingPage, readonly string[]>> = {
  keybindings: ["Keybindings"],
  updates: ["General › About"],
  here: ["Hosts › Running threads, Stuck after, Attachment limit", "Providers"],
  sharing: ["Hosts › Clients, Mac bridge, Remote access", "Environments"],
  publish: ["Hosts › Release"],
  defaults: ["Thread defaults"],
  orchestration: ["Orchestration"],
  sync: ["Hosts › Sync"],
  accounts: ["Accounts"],
  "computer:*": ["Hosts › a host's own section"],
  winvm: ["Work › Windows VM"],
  digest: ["Work › Digest"],
  mail: ["Work › Mail"],
  files: ["Work › Folders", "Work › Guest links", "Work › Word files"],
};

/** Names that live outside the map: add-ons and skills by name, each opening its page. */
export type SearchExtra = { title: string; page: SettingsPageId; path: string };

export const SEARCH_LIMIT = 40;

type Indexed = SearchResult & { names: string; old: readonly string[]; rank: number };

const pageKind = (row: ListRow): SettingPage => (row.kind === "computer" ? "computer:*" : row.kind === "job" ? "job" : row.kind === "workspace" ? "workspace" : (row.id as SettingPage));

/** A path's parts without a part said twice running (the Work page in the Work group). */
const pathOf = (...parts: (string | undefined)[]): string => parts.filter((part, i, all): part is string => !!part && part !== all[i - 1]).join(", ");

/** The other computers a per-computer row on a shared page is drawn for. */
const computersOf = (groups: readonly ListGroup[]): ListRow[] => listPages(groups).flatMap(({ row }) => (row.kind === "computer" ? [row] : []));

/** What this window is, for rows a page draws only in some windows (`SettingEntry.needs`). */
export type SearchWindow = { web?: boolean; mac?: boolean; work?: boolean };

const drawn = (entry: SettingEntry, window: SearchWindow): boolean =>
  !entry.needs || entry.needs.every((need) => (need === "desktop" ? !window.web : need === "mac" ? window.mac !== false : window.work !== false));

function index(groups: readonly ListGroup[], vars: SettingVars, extras: readonly SearchExtra[], window: SearchWindow): Indexed[] {
  const out: Indexed[] = [];
  const computers = computersOf(groups);
  for (const { row, group } of listPages(groups)) {
    const kind = pageKind(row);
    // A page is found by its row's label and by its own title, and a result says the title ("Threads on this Mac").
    const title = row.title ?? row.label;
    out.push({ key: `page:${row.id}`, title, path: pathOf(group.label), page: row.id, names: `${title} ${row.label}`, old: PAGE_WAS[kind] ?? [], rank: 0 });
    // A computer, a job or a workspace is its own place: its rows say its name, not the heading it stands under.
    const place = row.kind === "page" ? group.label : undefined;
    const own: SettingVars = row.kind === "computer" ? { ...vars, computer: nameInLine(row.label) } : vars;
    for (const entry of SETTINGS_MAP) {
      if (entry.page !== kind || !drawn(entry, window)) continue;
      // A row on a shared page that is drawn per computer ("The box on this Mac") lists once for each.
      const perComputer = row.kind !== "computer" && /\{computer\}/.test(entry.section + entry.title);
      if (!perComputer) out.push(rowResult(entry, row, place, own));
      else for (const computer of computers) out.push({ ...rowResult(entry, row, place, { ...vars, computer: nameInLine(computer.label) }), computer: computerOfSection(computer.id) ?? undefined });
    }
  }
  for (const extra of extras) out.push({ key: `extra:${extra.page}:${extra.title}`, title: extra.title, path: extra.path, page: extra.page, names: extra.title, old: [], rank: 1 });
  return out;
}

function rowResult(entry: SettingEntry, row: ListRow, place: string | undefined, vars: SettingVars): Indexed {
  const title = settingWords(entry.title, vars);
  const section = entry.section ? settingWords(entry.section, vars) : undefined;
  return {
    key: `${row.id}:${entry.id}:${vars.computer ?? ""}`,
    title,
    // The group's own page (Work's Setup, titled Work) is said by the group alone.
    // A computer's section that names it ("Threads on the box") says the name once.
    path: named(section, vars.computer) ? section! : pathOf(place, place && row.title === place ? undefined : row.label, section === title ? undefined : section),
    page: row.id,
    row: entry.id,
    names: title,
    old: entry.was,
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
    const { names, old, rank, ...result } = item;
    if (has(names, needles)) {
      scored.push({ result, score: rank * 2 + (names.toLowerCase().startsWith(typed) ? 0 : 1), at });
      return;
    }
    const was = old.find((name) => hadName(name, needles, rank > 0));
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
