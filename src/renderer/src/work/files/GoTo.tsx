import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { FileTab } from "@shared/contract-work-files";
import { parseGoTo, matchesName, nameWords, type GoToWhat } from "@shared/work/fileSearch";
import { MAKE_WORDS, type FileEntry } from "@shared/work/files";
import { Plus, Search } from "../../chrome/icons";
import { Input } from "../../components/ui/input";
import { registry } from "../../lib/connection";
import { KindGlyph } from "./KindGlyph";
import { whereWords } from "./model";

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
  onClose(): void;
}) {
  const [text, setText] = useState("");
  const [names, setNames] = useState<readonly FileEntry[]>([]);
  const [at, setAt] = useState(0);
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => field.current?.focus(), []);
  // The names for his words, asked as he types; an older answer never replaces a newer one.
  const asked = useRef(0);
  useEffect(() => {
    const mine = ++asked.current;
    if (parseGoTo(text).kind === "new") return void setNames([]);
    void registry
      .linkOf(link)
      .request<{ entries: FileEntry[] }>("work.files.names", { workspaceId, text })
      .then(
        (got) => mine === asked.current && setNames(got.entries),
        () => mine === asked.current && setNames([]),
      );
  }, [link, workspaceId, text]);
  const rows = useMemo(() => goToRows(text, tabs, names), [text, tabs, names]);
  const on = Math.min(at, Math.max(0, rows.length - 1));
  const take = (row: GoToRow | undefined): void => {
    if (!row) return;
    onPick(row);
    onClose();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    // The page's own keys (the arrows, Return, Delete) are the field's while it is open.
    event.stopPropagation();
    if (event.key === "ArrowDown") return void (event.preventDefault(), setAt(Math.min(rows.length - 1, on + 1)));
    if (event.key === "ArrowUp") return void (event.preventDefault(), setAt(Math.max(0, on - 1)));
    if (event.key === "Enter") return void (event.preventDefault(), take(rows[on]));
    if (event.key === "Escape") return void (event.preventDefault(), onClose());
  };
  const line = (row: GoToRow): { glyph: ReactNode; name: string; fact: string } => {
    if (row.is === "tab") return { glyph: <KindGlyph kind={row.tab.kind === "page" ? "folder" : "other"} tinted={row.tab.kind === "page"} />, name: row.tab.name, fact: "Open tab" };
    if (row.is === "new") return { glyph: <Plus aria-hidden className="size-4 shrink-0 text-muted-foreground" />, name: row.name ? `New ${MAKE_WORDS[row.what].toLowerCase()} called ${row.name}` : `New ${MAKE_WORDS[row.what].toLowerCase()}`, fact: "" };
    return { glyph: <KindGlyph kind={row.entry.kind} />, name: row.entry.name, fact: row.entry.where ? whereWords(row.entry.where) : "" };
  };
  return (
    <div data-files-goto className="relative flex min-w-0 flex-1 items-center">
      <Input
        ref={field}
        role="combobox"
        aria-label="Go to"
        aria-expanded={rows.length > 0}
        aria-controls="files-goto-list"
        aria-activedescendant={rows[on] ? `files-goto-${on}` : undefined}
        value={text}
        spellCheck={false}
        placeholder="Go to a file or a folder, or type “new sheet called…”"
        className="h-7 min-w-0 flex-1 text-[13px]"
        onChange={(event) => {
          setText(event.target.value);
          setAt(0);
        }}
        onKeyDown={onKeyDown}
        onBlur={onClose}
      />
      {rows.length ? (
        <div id="files-goto-list" role="listbox" aria-label="Go to" className="absolute inset-x-0 top-9 z-30 flex max-h-80 flex-col overflow-x-hidden overflow-y-auto rounded-xl bg-popover p-1 text-popover-foreground shadow-overlay ring-1 ring-border">
          {rows.map((row, index) => {
            const { glyph, name, fact } = line(row);
            return (
              <div
                key={rowKey(row)}
                id={`files-goto-${index}`}
                role="option"
                aria-selected={index === on}
                className={`flex h-8 shrink-0 cursor-default items-center gap-2 rounded-md px-2 text-[13px] select-none ${index === on ? "bg-muted" : ""}`}
                // The press is taken before the field's blur closes the panel.
                onMouseDown={(event) => {
                  event.preventDefault();
                  take(row);
                }}
                onMouseEnter={() => setAt(index)}
              >
                {glyph}
                <span className="min-w-0 flex-1 truncate text-foreground">{name}</span>
                {fact ? <span className="max-w-[45%] shrink-0 truncate text-xs text-muted-foreground">{fact}</span> : null}
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Search (docs/DESIGN.md "The Files place"): a field in the trail's place. As he types it filters the folder
 * shown; Return searches every place, as a page of results; Escape puts the trail and the whole folder back.
 */
export function SearchField({ start, onFilter, onSearch, onClose }: { start: string; onFilter(text: string): void; onSearch(text: string): void; onClose(): void }) {
  const [text, setText] = useState(start);
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
        placeholder="Filter this folder; Return searches every place"
        className="h-7 min-w-0 flex-1 text-[13px]"
        onChange={(event) => {
          setText(event.target.value);
          onFilter(event.target.value);
        }}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === "Enter" && text.trim()) return void (event.preventDefault(), onSearch(text.trim()));
          if (event.key === "Escape") return void (event.preventDefault(), onFilter(""), onClose());
        }}
        // Left empty, the trail comes back; with words in it the filter stays until he clears it.
        onBlur={() => (text.trim() ? undefined : onClose())}
      />
    </div>
  );
}
