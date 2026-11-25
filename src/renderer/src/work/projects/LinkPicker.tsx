import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { FindAnswer } from "@shared/contract-work-docs";
import type { ProjectLinked } from "@shared/contract-work-projects";
import { FIND_KIND_WORDS, FIND_WHERE_WORDS, type FindEntry } from "@shared/work/docFind";
import { mentionMatches } from "@shared/work/mentions";
import { PickerDialog, PickerNote, pickerRowClass } from "../../chrome/PickerDialog";
import { usePointerHighlight } from "../../hooks/usePointerHighlight";
import { BusyLabel, Button } from "../../components/ui/button";
import { registry } from "../../lib/connection";
import { hostFailure } from "../../lib/hostFailure";

/**
 * Link a document, or a file or item, to a project (docs/agents/work-projects.md
 * "Documents"): the go-to picker over what the workspace already lists
 * (`work.docs.find`, the docs pillar's catalog), narrowed to what this row
 * links. A pick writes `work.projects.link` on the workspace's host, which
 * checks the sector and fences a file's path; a refusal stays in the picker
 * as its one line. A list that did not come is a red line with Retry (Enter
 * in the field presses it), and what he typed stays.
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
  const [listError, setListError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  // His Retry keeps the failure in place, its Retry spinning, until the list answers or fails again.
  const [retrying, setRetrying] = useState(false);
  const [linking, setLinking] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    registry
      .linkOf(env)
      .request<FindAnswer>("work.docs.find", { workspaceId, refresh: true })
      .then((answer) => {
        if (!live) return;
        setFound(answer.entries);
        setListError(null);
      })
      .catch((err: unknown) => live && setListError(hostFailure(env, err, "could not list what to link")))
      .finally(() => live && setRetrying(false));
    return () => {
      live = false;
    };
  }, [env, workspaceId, attempt]);
  // The query stays as he typed it: the list comes back narrowed by it.
  const retry = (): void => {
    if (retrying) return;
    setRetrying(true);
    setAttempt((n) => n + 1);
  };

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
        setError(hostFailure(env, err, "did not link it", true));
      });
  };

  const onSearchKey = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (rows.length) setActive((i) => (i + (e.key === "ArrowDown" ? 1 : rows.length - 1)) % rows.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (listError) return retry();
      const entry = rows[active];
      if (entry) pick(entry);
    } else if (e.key === "Tab") e.preventDefault();
  };

  // Every LifeOS document and sheet the workspace lists, this project's own included: whether "all are here already" is true.
  const any = useMemo(() => (found ?? []).some((e) => e.source.at === "lifeos" && (e.source.table === "docs" || e.source.table === "sheets")), [found]);
  const none = kind === "item" ? "No file or item to link" : any ? "Every document and sheet here is in this project already" : "No document or sheet to link";
  const note = listError ? null : (error ?? (found === null ? "Loading…" : rows.length === 0 ? (query.trim() ? "No match" : none) : null));
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
      {listError ? (
        // A note's 28px line, in red, with its way back at the end.
        <div role="alert" data-link-picker-failed className="flex min-h-7 items-center gap-2 pr-1 pl-3 text-[13px]">
          <span className="min-w-0 flex-1 text-destructive">{listError}</span>
          <Button variant="ghost" size="xs" disabled={retrying} onClick={retry}>
            <BusyLabel busy={retrying} label="Retry" />
          </Button>
        </div>
      ) : note ? (
        <PickerNote>{note}</PickerNote>
      ) : null}
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
