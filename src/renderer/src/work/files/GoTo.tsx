import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { FileTab } from "@shared/contract-work-files";
import { parseGoTo, matchesName, nameWords, type GoToWhat } from "@shared/work/fileSearch";
import { MAKE_WORDS, type FileEntry } from "@shared/work/files";
import { Plus, Search } from "../../chrome/icons";
import { BusyLabel, Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { TruncateTip } from "../../components/tip";
import { Spinner } from "../../components/ui/spinner";
import { registry } from "../../lib/connection";
import { KindGlyph } from "./KindGlyph";
import { shownName } from "./model";
import { WhereWords } from "./rowParts";

/**
 * Go to (docs/DESIGN.md "The Files place"): the trail turns into a field, and a panel under it lists as he
 * types: the open tabs and recent files first, then files and folders by name from every place of the
 * workspace's host, then "New sheet called …" when his words start with new. Return takes the first row; the
 * arrows walk; Escape and a press elsewhere put the trail back. Nothing is asked of a host but names it has
 * already listed, so the list is there as fast as he types.
 */

/** What Go to found for his words: one row to take. */
export type GoToRow =
  | { is: "tab"; tab: FileTab }
  | { is: "entry"; entry: FileEntry }
  | { is: "new"; what: GoToWhat; name: string };

/** How long a lookup may take before the panel says it is still loading. */
export const SLOW_MS = 250;
const NO_ENTRIES: readonly FileEntry[] = [];

const rowKey = (row: GoToRow): string => (row.is === "tab" ? `tab:${row.tab.id}` : row.is === "entry" ? `entry:${row.entry.key}` : `new:${row.what}`);

/** The rows for his words: tabs that hold every word, the host's names (less the files a listed tab already shows), then the new thing his words ask for. */
export function goToRows(text: string, tabs: readonly FileTab[], names: readonly FileEntry[]): GoToRow[] {
  const asked = parseGoTo(text);
  if (asked.kind === "new") return [{ is: "new", what: asked.what, name: asked.name }];
  const words = nameWords(asked.text);
  const open = words.length ? tabs.filter((tab) => matchesName(tab.name, words)) : [];
  const shown = new Set(open.flatMap((tab) => (tab.key ? [tab.key] : [])));
  return [...open.map((tab): GoToRow => ({ is: "tab", tab })), ...names.filter((entry) => !shown.has(entry.key)).map((entry): GoToRow => ({ is: "entry", entry }))];
}

/** What held the focus as a field opened: where Escape gives it back (a press elsewhere leaves it where it landed). */
const openedFrom = (): Element | null => (document.activeElement && document.activeElement !== document.body ? document.activeElement : null);

/**
 * Gives the focus back after Escape closed Go to or Search: to what opened it while that is still on the page (the
 * list, a row), else to the bar's press of the same name, which stands again where the field was.
 */
export function closedBack(opener: Element | null, press: HTMLElement | null): void {
  const to = opener instanceof HTMLElement && opener.isConnected ? opener : press;
  to?.focus();
}

export function GoToField({
  link,
  workspaceId,
  tabs,
  onPick,
  onClose,
}: {
  /** the workspace's host, which keeps the names */
  link: string;
  workspaceId: string;
  tabs: readonly FileTab[];
  onPick(row: GoToRow): void;
  /** `back`: closed by Escape, so the focus goes back where Go to was opened from (`closedBack`) */
  onClose(back?: Element | null): void;
}) {
  const [text, setText] = useState("");
  const [opener] = useState(openedFrom);
  // The names the host answered, and the words they answer: the rows stay drawn, inert, while newer words are asked,
  // and give way to Loading… once the lookup is slow, so no row of older words is taken or read as his.
  // A lookup that failed says so, with Retry, rather than reading as no match.
  // His Retry keeps the failure in place, its Retry spinning, until the answer replaces it.
  const [names, setNames] = useState<{ text: string | null; entries: readonly FileEntry[]; failed?: boolean; retrying?: boolean }>({ text: null, entries: [] });
  const [tries, setTries] = useState(0);
  const [at, setAt] = useState(0);
  // Return pressed before the names for his words came: the words it was pressed for, and it takes the first row once
  // their names do. New words drop it: Return is bound to the query that got it, never to words typed after.
  const [waiting, setWaiting] = useState<string | null>(null);
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => field.current?.focus(), []);
  // The names for his words, asked as he types; an older answer never replaces a newer one.
  const asked = useRef(0);
  useEffect(() => {
    const mine = ++asked.current;
    if (parseGoTo(text).kind === "new") return void setNames({ text, entries: [] });
    void registry
      .linkOf(link)
      .request<{ entries: FileEntry[] }>("work.files.names", { workspaceId, text })
      .then(
        (got) => mine === asked.current && setNames({ text, entries: got.entries }),
        () => mine === asked.current && setNames({ text, entries: [], failed: true }),
      );
  }, [link, workspaceId, text, tries]);
  const fresh = names.text === text || parseGoTo(text).kind === "new";
  // One muted row under the list says where the lookup stands: still asked, refused (with Retry), or no match for his words.
  // A lookup still out after a beat says so; a quick one never flashes the row as he types.
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    setSlow(false);
    if (fresh) return;
    const timer = setTimeout(() => setSlow(true), SLOW_MS);
    return () => clearTimeout(timer);
  }, [fresh, text, tries]);
  const kept = fresh || !slow ? names.entries : NO_ENTRIES;
  const rows = useMemo(() => goToRows(text, tabs, kept), [text, tabs, kept]);
  const on = Math.min(at, Math.max(0, rows.length - 1));
  const status: "loading" | "failed" | "none" | null = !fresh ? (slow ? "loading" : null) : names.failed ? "failed" : !rows.length && text.trim() ? "none" : null;
  const retry = (): void => {
    setNames((was) => ({ ...was, retrying: true }));
    setTries((n) => n + 1);
    // Retry goes as the lookup starts again: the field takes the keys back.
    field.current?.focus();
  };
  const take = (row: GoToRow | undefined): void => {
    // A name of older words is not his to take; Return waits for the names of his own.
    if (!row || (row.is === "entry" && !fresh)) return;
    onPick(row);
    onClose();
  };
  useEffect(() => {
    if (waiting === null || !fresh) return;
    setWaiting(null);
    if (waiting === text) take(rows[on]);
    // Run once the names for his words have come; `take` and the rows are this render's.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [waiting, fresh, text]);
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    // The page's own keys (the arrows, Return, Delete) are the field's while it is open.
    event.stopPropagation();
    if (event.key === "ArrowDown") return void (event.preventDefault(), setAt(Math.min(rows.length - 1, on + 1)));
    if (event.key === "ArrowUp") return void (event.preventDefault(), setAt(Math.max(0, on - 1)));
    // Return takes a row of the names for the words in the field, never of words he has since typed over.
    if (event.key === "Enter") return void (event.preventDefault(), fresh ? take(rows[on]) : setWaiting(text));
    if (event.key === "Escape") return void (event.preventDefault(), onClose(opener));
  };
  const line = (row: GoToRow): { glyph: ReactNode; name: string; fact: ReactNode } => {
    // A name as every row shows it: TempCode's own ending (".tcdoc", ".tcsheet") is no word.
    if (row.is === "tab") return { glyph: <KindGlyph kind={row.tab.kind === "page" ? "folder" : "other"} tinted={row.tab.kind === "page"} />, name: shownName(row.tab.name), fact: "Open tab" };
    if (row.is === "new") return { glyph: <Plus aria-hidden className="size-4 shrink-0 text-muted-foreground" />, name: row.name ? `New ${MAKE_WORDS[row.what].toLowerCase()} called ${row.name}` : `New ${MAKE_WORDS[row.what].toLowerCase()}`, fact: "" };
    return { glyph: <KindGlyph kind={row.entry.kind} />, name: shownName(row.entry.name), fact: row.entry.where ? <WhereWords where={row.entry.where} /> : "" };
  };
  return (
    // Go to closes when the focus leaves the field and its panel together: Tab from the field to Retry keeps it open.
    <div
      data-files-goto
      className="relative flex min-w-0 flex-1 items-center"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) onClose();
      }}
      onKeyDown={(event) => {
        // The page's keys are Go to's while it is open; Escape from Retry closes it as from the field.
        event.stopPropagation();
        if (event.key === "Escape" && event.target !== field.current) return void (event.preventDefault(), onClose(opener));
      }}
    >
      <Input
        ref={field}
        role="combobox"
        aria-label="Go to"
        aria-expanded={rows.length > 0 || status !== null}
        aria-controls="files-goto-list"
        aria-activedescendant={rows[on] ? `files-goto-${on}` : undefined}
        value={text}
        spellCheck={false}
        placeholder="Go to"
        className="h-7 min-w-0 flex-1 text-[13px]"
        onChange={(event) => {
          setText(event.target.value);
          setAt(0);
          setWaiting(null);
        }}
        onKeyDown={onKeyDown}
      />
      {rows.length || status ? (
        // At least 360px where the bar has room, so a name is not cut to a word beside where it lives. The rows are the
        // listbox; the lookup's line and its Retry stand under it, in the panel but outside the list.
        <div className="absolute start-0 top-9 z-30 flex max-h-80 w-full min-w-[min(22.5rem,calc(100cqw-5rem))] flex-col overflow-x-hidden overflow-y-auto rounded-xl bg-popover p-1 text-popover-foreground shadow-overlay ring-1 ring-border">
          <div id="files-goto-list" role="listbox" aria-label="Go to" className="flex flex-col">
            {rows.map((row, index) => {
              const { glyph, name, fact } = line(row);
              const inert = row.is === "entry" && !fresh;
              return (
                <div
                  key={rowKey(row)}
                  id={`files-goto-${index}`}
                  role="option"
                  aria-selected={index === on}
                  {...(inert ? { "aria-disabled": true } : {})}
                  className={`flex h-8 shrink-0 cursor-default items-center gap-2 rounded-md px-2 text-[13px] select-none ${index === on ? "bg-muted" : ""}`}
                  // The press is taken before the field's blur closes the panel.
                  onMouseDown={(event) => {
                    event.preventDefault();
                    take(row);
                  }}
                  onMouseEnter={() => setAt(index)}
                >
                  {glyph}
                  {/* The name is what he picks: it keeps its room, and where the file lives gives way first, down to
                      10em (the place's 4em and 6em of folder), the folder it lies in kept and the place cut (`WhereWords`), as search's Where does. */}
                  <TruncateTip text={name}>
                    <span className="min-w-0 flex-auto truncate text-foreground">{name}</span>
                  </TruncateTip>
                  {fact ? <span data-files-goto-fact className="flex max-w-[45%] min-w-[10em] shrink-[8] justify-end text-xs text-muted-foreground">{typeof fact === "string" ? <span className="truncate">{fact}</span> : fact}</span> : null}
                </div>
              );
            })}
          </div>
          {status === "loading" ? (
            <div className="flex h-8 shrink-0 items-center gap-2 px-2 text-[13px] text-muted-foreground">
              <Spinner className="size-3.5" />
              <span aria-hidden>Loading…</span>
            </div>
          ) : status === "failed" ? (
            <div role="alert" className="flex h-8 shrink-0 items-center gap-2 ps-2 text-[13px]">
              <span className="min-w-0 flex-1 truncate text-destructive">Couldn't load names</span>
              {/* A press keeps the focus in the field; Tab from the field reaches it too. */}
              <Button variant="ghost" size="xs" disabled={!!names.retrying} onMouseDown={(event) => event.preventDefault()} onClick={retry}>
                <BusyLabel busy={!!names.retrying} label="Retry" />
              </Button>
            </div>
          ) : status === "none" ? (
            <div role="status" className="flex h-8 shrink-0 items-center px-2 text-[13px] text-muted-foreground">
              No matches
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Search (docs/DESIGN.md "The Files place"): a field in the trail's place. As he types it filters the folder
 * shown; Return searches every place, as a page of results; Escape puts the trail and the whole folder back.
 */
export function SearchField({ start, onFilter, onSearch, onClose }: { start: string; onFilter(text: string): void; onSearch(text: string): void; onClose(back?: Element | null): void }) {
  const [text, setText] = useState(start);
  const [opener] = useState(openedFrom);
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => {
    field.current?.focus();
    field.current?.select();
  }, []);
  return (
    <div data-files-search className="flex min-w-0 flex-1 items-center gap-2">
      <Search aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
      <Input
        ref={field}
        type="search"
        aria-label="Search"
        value={text}
        spellCheck={false}
        placeholder="Search"
        className="h-7 min-w-0 flex-1 text-[13px]"
        onChange={(event) => {
          setText(event.target.value);
          onFilter(event.target.value);
        }}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === "Enter" && text.trim()) return void (event.preventDefault(), onSearch(text.trim()));
          if (event.key === "Escape") return void (event.preventDefault(), onFilter(""), onClose(opener));
        }}
        // Left empty, the trail comes back; with words in it the filter stays until he clears it.
        onBlur={() => (text.trim() ? undefined : onClose())}
      />
    </div>
  );
}
