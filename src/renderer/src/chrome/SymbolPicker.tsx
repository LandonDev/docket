import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { useLockOverscroll } from "../hooks/useLockOverscroll";
import { usePointerHighlight } from "../hooks/usePointerHighlight";
import type { EditorNavigation } from "../lib/search";
import type { WorkspaceSymbolRow } from "../surfaces/monaco/lsp/providers";
import { PickerDialog, PickerNote, pickerRowClass } from "./PickerDialog";
import { MatchText } from "./MatchText";

/**
 * ⌘⇧O: workspace symbols from the project's running language servers
 * (`workspaceSymbols` in surfaces/monaco/lsp/providers.ts, loaded lazily so
 * the shell stays free of the editor chunk). Queries settle for 250 ms.
 */

type Props = {
  projectId: string | null;
  onOpen: (path: string, navigation: EditorNavigation) => void;
  onClose: () => void;
};

const SETTLE_MS = 250;

// monaco.languages.SymbolKind, by ordinal; no monaco import in the shell.
const KIND_LABELS = [
  "file", "module", "namespace", "package", "class", "method", "property",
  "field", "constructor", "enum", "interface", "function", "variable",
  "constant", "string", "number", "boolean", "array", "object", "key",
  "null", "enum member", "struct", "event", "operator", "type parameter",
];

function pathOf(uri: string): string {
  try {
    const url = new URL(uri);
    return url.protocol === "file:" ? decodeURIComponent(url.pathname) : uri;
  } catch {
    return uri;
  }
}

export function SymbolPicker({ projectId, onOpen, onClose }: Props) {
  const search = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  /** The last answer and the words it answers: rows of an older query are never drawn, nor opened by Enter (S F9.1, round 4). */
  const [answer, setAnswer] = useState<{ key: string; rows: WorkspaceSymbolRow[]; failure: "none" | "failed" | null } | null>(null);
  const trimmed = query.trim();
  const key = `${projectId ?? ""}\n${trimmed}`;
  const current = answer?.key === key ? answer : null;
  const rows = current?.rows ?? [];
  /** A failure is said as one, never as "No matching symbols". */
  const failure = current?.failure ?? null;
  // From the first key of a new query: the old rows go, and the picker says "Searching…" until its answer lands.
  const searching = !!projectId && !!trimmed && !current;

  useEffect(() => {
    if (!projectId || !trimmed) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void import("../surfaces/monaco/lsp/providers")
        .then(({ workspaceSymbols }) => workspaceSymbols(projectId, trimmed))
        .then((next) => {
          if (cancelled) return;
          setAnswer({ key: `${projectId}\n${trimmed}`, rows: next, failure: null });
          setActive(0);
        })
        .catch((err: { symbolSearch?: "none" | "failed" }) => {
          if (cancelled) return;
          setAnswer({ key: `${projectId}\n${trimmed}`, rows: [], failure: err?.symbolSearch === "none" ? "none" : "failed" });
        });
    }, SETTLE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [projectId, trimmed]);

  const listId = useId();
  const pick = (row: WorkspaceSymbolRow) => {
    onOpen(pathOf(row.uri), {
      line: row.range.startLineNumber,
      column: row.range.startColumn,
    });
    onClose();
  };

  const onSearchKey = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (rows.length === 0) return;
      const delta = e.key === "ArrowDown" ? 1 : rows.length - 1;
      setActive((index) => (index + delta) % rows.length);
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const row = rows[active];
      if (row) pick(row);
      return;
    }
    if (e.key === "Tab") e.preventDefault();
  };

  const empty = !projectId
    ? "Open a project to search symbols"
    : !query.trim()
      ? "Type a symbol name"
      : searching
        ? "Searching…"
        : failure === "none"
          ? "No language server is running for this project"
          : failure
            ? "Couldn't search symbols"
            : rows.length === 0
              ? "No matching symbols"
              : null;

  return (
    <PickerDialog
      label="Go to symbol"
      data-symbol-picker
      search={search}
      query={query}
      onQuery={(next) => {
        setQuery(next);
        setActive(0);
      }}
      onSearchKey={onSearchKey}
      onClose={onClose}
      // The field is the list's combobox, so a reader hears the row the arrows are on.
      listId={empty ? undefined : listId}
      activeId={rows[active] ? `${listId}-${active}` : null}
    >
      {empty ? <PickerNote>{empty}</PickerNote> : <SymbolList id={listId} rows={rows} active={active} query={query} onActive={setActive} onPick={pick} />}
    </PickerDialog>
  );
}

export function SymbolList({
  id,
  rows,
  active,
  query = "",
  onActive,
  onPick,
}: {
  id: string;
  rows: WorkspaceSymbolRow[];
  active: number;
  /** The words typed: the name marks them as file rows mark theirs. */
  query?: string;
  onActive: (index: number) => void;
  onPick: (row: WorkspaceSymbolRow) => void;
}) {
  const lockOverscroll = useLockOverscroll<HTMLDivElement>();
  const { activeRef, onMouseMove, onRowEnter } = usePointerHighlight<HTMLDivElement>({ active, items: rows, onActive });

  return (
    <div
      ref={lockOverscroll}
      id={id}
      role="listbox"
      aria-label="Symbols"
      onMouseMove={onMouseMove}
      className="max-h-[min(380px,50vh)] overflow-x-hidden overflow-y-auto overscroll-none [--scrollbar-inset:var(--radius-xl)]"
    >
      {rows.map((row, index) => {
        const highlighted = index === active;
        const path = pathOf(row.uri);
        const file = path.slice(path.lastIndexOf("/") + 1);
        return (
          <div
            key={`${row.uri}:${row.range.startLineNumber}:${row.name}:${index}`}
            id={`${id}-${index}`}
            ref={highlighted ? activeRef : undefined}
            role="option"
            aria-selected={highlighted}
            onMouseDown={(e) => e.preventDefault()}
            onMouseEnter={() => onRowEnter(index)}
            onClick={() => onPick(row)}
            className={pickerRowClass(highlighted)}
          >
            {/* Wide enough for "constructor" and "type parameter" whole. */}
            <span className="w-24 shrink-0 truncate text-xs text-muted-foreground">
              {KIND_LABELS[row.kind] ?? "symbol"}
            </span>
            <span className="min-w-0 flex-1 truncate">
              <MatchText text={row.name} query={query.trim()} />
              {row.containerName ? (
                <span className="ms-1 text-muted-foreground">{row.containerName}</span>
              ) : null}
            </span>
            <span className="min-w-0 max-w-[45%] truncate font-mono text-xs text-muted-foreground">
              {file}:{row.range.startLineNumber}
            </span>
          </div>
        );
      })}
    </div>
  );
}
