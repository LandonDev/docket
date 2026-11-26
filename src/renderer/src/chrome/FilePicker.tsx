import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import {
  loadProjectFiles,
  peekProjectFiles,
  rankProjectFiles,
  recentOpenedFiles,
  type RankedFile,
  subscribeProjectFilesDropped,
} from "../lib/fileIndex";
import { useRankQuery } from "../lib/rankQuery";
import { looksLikeProject } from "../lib/recents";
import { useLockOverscroll } from "../hooks/useLockOverscroll";
import { usePointerHighlight } from "../hooks/usePointerHighlight";
import { Button } from "../components/ui/button";
import { FileTypeIcon } from "./FileTypeIcon";
import { MatchText } from "./MatchText";
import { PickerDialog, PickerNote, pickerRowClass } from "./PickerDialog";

type Props = {
  open: boolean;
  cwd: string;
  openPaths?: string[];
  onOpenFile: (path: string) => void;
  onClose: () => void;
};

export function FilePicker({
  open,
  cwd,
  openPaths = [],
  onOpenFile,
  onClose,
}: Props) {
  const search = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [files, setFiles] = useState(() => peekProjectFiles(cwd) ?? []);
  const [loading, setLoading] = useState(() => peekProjectFiles(cwd) == null);
  const [error, setError] = useState(false);
  // The open picker's own read, asked again by Retry without clearing his words.
  const reload = useRef<() => void>(() => {});

  const recents = useMemo(() => {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const path of [...recentOpenedFiles(cwd), ...openPaths]) {
      if (seen.has(path)) continue;
      seen.add(path);
      out.push(path);
    }
    return out;
  }, [cwd, openPaths, open]);

  // Past 5,000 paths the ranking runs in a transition (lib/rankQuery.ts).
  const rankQuery = useRankQuery(query, files.length);
  const results = useMemo(
    () => rankProjectFiles(files, rankQuery, recents),
    [files, rankQuery, recents],
  );

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActive(0);
    setError(false);
    const cached = peekProjectFiles(cwd);
    if (cached) {
      setFiles(cached);
      setLoading(false);
    } else {
      setFiles([]);
      setLoading(looksLikeProject(cwd));
    }
    if (!looksLikeProject(cwd)) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    const load = () =>
      void loadProjectFiles(cwd, true)
        .then((next) => {
          if (cancelled) return;
          setFiles(next);
          setLoading(false);
        })
        .catch(() => {
          if (cancelled) return;
          // The host's own text stays in its log; the line says what did not happen.
          setError(true);
          setLoading(false);
        });
    load();
    reload.current = () => {
      if (cancelled) return;
      setError(false);
      setLoading(true);
      load();
    };
    // The host's key changed or the host left while the picker is open: its names were another key's
    // (lib/fileIndex.ts). They go, the loading state shows, and the list is asked again.
    const offDropped = subscribeProjectFilesDropped(cwd, () => {
      if (cancelled) return;
      setFiles([]);
      setError(false);
      setLoading(true);
      load();
    });
    return () => {
      cancelled = true;
      offDropped();
    };
  }, [open, cwd]);

  useEffect(() => {
    setActive((index) =>
      results.length === 0 ? 0 : Math.min(index, results.length - 1),
    );
  }, [results.length]);

  const listId = useId();
  const pick = (file: RankedFile) => {
    onOpenFile(file.path);
    onClose();
  };

  const onSearchKey = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (results.length === 0) return;
      setActive((index) => (index + 1) % results.length);
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      if (results.length === 0) return;
      setActive((index) => (index - 1 + results.length) % results.length);
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const file = results[active];
      if (file) pick(file);
      return;
    }
    // The field keeps the keys; a failed read's Retry is the one other stop.
    if (e.key === "Tab" && !error) e.preventDefault();
  };

  const empty = emptyLabel({
    cwd,
    query,
    loading,
    fileCount: files.length,
    matchCount: results.length,
  });

  return (
    <PickerDialog
      open={open}
      label="Go to file"
      data-file-picker
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
      activeId={results[active] ? `${listId}-${active}` : null}
    >
      {/* A failed read keeps the last good rows under one red line with Retry; no empty note stands in for it. */}
      {error ? (
        <p role="alert" data-file-picker-failed className="flex h-7 items-center gap-2 pl-3 text-xs text-destructive">
          <span className="min-w-0 flex-1 truncate">Couldn't list this project's files</span>
          <Button variant="ghost" size="xs" onClick={() => reload.current()}>
            Retry
          </Button>
        </p>
      ) : null}
      {empty ? (
        error ? null : <PickerNote>{empty}</PickerNote>
      ) : (
        <FileList id={listId} files={results} active={active} query={query} onActive={setActive} onPick={pick} />
      )}
    </PickerDialog>
  );
}

function emptyLabel({
  cwd,
  query,
  loading,
  fileCount,
  matchCount,
}: {
  cwd: string;
  query: string;
  loading: boolean;
  fileCount: number;
  matchCount: number;
}): string | null {
  if (!looksLikeProject(cwd)) return "Open a project to search files";
  if (loading && fileCount === 0) return "Indexing files…";
  if (fileCount === 0) return "No files found";
  if (matchCount === 0) {
    return query.trim() ? "No matching files" : "Type a file name to search";
  }
  return null;
}

export function FileList({
  id,
  files,
  active,
  query,
  onActive,
  onPick,
}: {
  id: string;
  files: RankedFile[];
  active: number;
  query: string;
  onActive: (index: number) => void;
  onPick: (file: RankedFile) => void;
}) {
  const lockOverscroll = useLockOverscroll<HTMLDivElement>();
  const { activeRef, onMouseMove, onRowEnter } = usePointerHighlight<HTMLDivElement>({ active, items: files, onActive });

  return (
    <div
      ref={lockOverscroll}
      id={id}
      role="listbox"
      aria-label="Files"
      onMouseMove={onMouseMove}
      className="max-h-[min(380px,50vh)] overflow-x-hidden overflow-y-auto overscroll-none [--scrollbar-inset:var(--radius-xl)]"
    >
      {files.map((file, index) => {
        const highlighted = index === active;
        const slash = file.relative.lastIndexOf("/");
        const dir = slash === -1 ? "" : file.relative.slice(0, slash);
        const nameOffset = slash === -1 ? 0 : slash + 1;
        return (
          <div
            key={file.path}
            id={`${id}-${index}`}
            ref={highlighted ? activeRef : undefined}
            role="option"
            aria-selected={highlighted}
            onMouseDown={(e) => e.preventDefault()}
            onMouseEnter={() => onRowEnter(index)}
            onClick={() => onPick(file)}
            className={pickerRowClass(highlighted)}
          >
            <span className="shrink-0">
              <FileTypeIcon name={file.name} isDir={false} />
            </span>
            <span className="min-w-0 flex-1 truncate">
              <MatchText
                text={file.name}
                positions={file.positions
                  .filter((pos) => pos >= nameOffset)
                  .map((pos) => pos - nameOffset)}
                active={Boolean(query.trim())}
              />
            </span>
            {dir ? (
              <span className="min-w-0 max-w-[45%] truncate font-mono text-xs text-muted-foreground">
                <MatchText
                  text={dir}
                  positions={file.positions.filter((pos) => pos < slash)}
                  active={Boolean(query.trim())}
                />
              </span>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
