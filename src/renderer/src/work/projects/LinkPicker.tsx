import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { FindAnswer } from "@shared/contract-work-docs";
import type { ProjectLinked } from "@shared/contract-work-projects";
import { FIND_KIND_WORDS, FIND_WHERE_WORDS, type FindEntry } from "@shared/work/docFind";
import { mentionMatches } from "@shared/work/mentions";
import { PickerDialog, PickerNote, pickerRowClass } from "../../chrome/PickerDialog";
import { usePointerHighlight } from "../../hooks/usePointerHighlight";
import { registry } from "../../lib/connection";

/**
 * Link a document, or a file or item, to a project (docs/agents/work-projects.md
 * "Documents"): the go-to picker over what the workspace already lists
 * (`work.docs.find`, the docs pillar's catalog), narrowed to what this row
 * links. A pick writes `work.projects.link` on the workspace's host, which
 * checks the sector and fences a file's path; a refusal stays in the picker
 * as its one line.
 */

/** What a picker lists: LifeOS's own documents and sheets, or everything else a project can list. */
export type LinkKind = "document" | "item";

/** The workspace's entries a picker of this kind offers for a project: never one it already holds, never an item only a thread can name. */
export function linkable(entries: readonly FindEntry[], kind: LinkKind, projectId: string): FindEntry[] {
  return entries.filter((e) => {
    const s = e.source;
    if (s.at === "thread" || s.at === "browser") return false;
    const lifeos = s.at === "lifeos";
    if (kind === "document") return lifeos && (s.table === "docs" || s.table === "sheets") && e.projectId !== projectId;
    return !lifeos;
  });
}

const LABEL: Record<LinkKind, string> = { document: "Link a document or sheet", item: "Link a file or item" };

export function LinkPicker({ env, workspaceId, project, kind, onClose }: { env: string; workspaceId: string; project: { id: string; name: string }; kind: LinkKind; onClose: () => void }) {
  const search = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [found, setFound] = useState<FindEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [linking, setLinking] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    registry
      .linkOf(env)
      .request<FindAnswer>("work.docs.find", { workspaceId, refresh: true })
      .then((answer) => live && setFound(answer.entries))
      .catch((err: unknown) => live && setError(err instanceof Error ? err.message : String(err)));
    return () => {
      live = false;
    };
  }, [env, workspaceId]);

  const rows = useMemo(() => linkable(found ?? [], kind, project.id).filter((e) => mentionMatches(query, e.title)), [found, kind, project.id, query]);
  useEffect(() => setActive((i) => (rows.length === 0 ? 0 : Math.min(i, rows.length - 1))), [rows.length]);
  const { activeRef, onRowEnter, onMouseMove } = usePointerHighlight<HTMLButtonElement>({ active, items: rows, onActive: setActive });

  const pick = (entry: FindEntry): void => {
    if (linking) return;
    setLinking(entry.key);
    setError(null);
    registry
      .linkOf(env)
      .request<ProjectLinked>("work.projects.link", { workspaceId, lifeosProjectId: project.id, source: entry.source, title: entry.title.slice(0, 500) })
      .then(onClose, (err: unknown) => {
        setLinking(null);
        setError(err instanceof Error ? err.message : String(err));
      });
  };

  const onSearchKey = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (rows.length) setActive((i) => (i + (e.key === "ArrowDown" ? 1 : rows.length - 1)) % rows.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const entry = rows[active];
      if (entry) pick(entry);
    } else if (e.key === "Tab") e.preventDefault();
  };

  // Every LifeOS document and sheet the workspace lists, this project's own included: whether "all are here already" is true.
  const any = useMemo(() => (found ?? []).some((e) => e.source.at === "lifeos" && (e.source.table === "docs" || e.source.table === "sheets")), [found]);
  const none = kind === "item" ? "No file or item to link" : any ? "Every document and sheet here is in this project already" : "No document or sheet to link";
  const note = error ?? (found === null ? "Loading…" : rows.length === 0 ? (query.trim() ? "No match" : none) : null);
  return (
    <PickerDialog
      label={`${LABEL[kind]} to ${project.name}`}
      data-link-picker
      search={search}
      query={query}
      onQuery={(next) => {
        setQuery(next);
        setActive(0);
      }}
      onSearchKey={onSearchKey}
      onClose={onClose}
    >
      {note ? <PickerNote>{note}</PickerNote> : null}
      {rows.length ? (
        <div role="listbox" aria-label={LABEL[kind]} className="flex max-h-[320px] flex-col overflow-x-hidden overflow-y-auto" onMouseMove={onMouseMove}>
          {rows.map((entry, i) => (
            <button
              key={entry.key}
              ref={i === active ? activeRef : undefined}
              type="button"
              role="option"
              aria-selected={i === active}
              aria-busy={linking === entry.key || undefined}
              disabled={!!linking}
              className={pickerRowClass(i === active)}
              onMouseEnter={() => onRowEnter(i)}
              onClick={() => pick(entry)}
            >
              <span className="min-w-0 flex-1 truncate text-[13px] text-foreground">{entry.title || "Untitled"}</span>
              {/* Every row of the document picker is LifeOS's: the place is said only where places mix. */}
              <span className="shrink-0 text-xs text-muted-foreground">{kind === "document" ? FIND_KIND_WORDS[entry.kind] : `${FIND_KIND_WORDS[entry.kind]}, ${FIND_WHERE_WORDS[entry.where]}`}</span>
            </button>
          ))}
        </div>
      ) : null}
    </PickerDialog>
  );
}
