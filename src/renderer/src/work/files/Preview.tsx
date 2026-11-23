import { useEffect, useRef, useState, type ReactNode } from "react";
import type { FileBytes } from "@shared/contract-work-files";
import { ENTRY_KIND_WORDS, extOf, type FileEntry } from "@shared/work/files";
import { BusyLabel, Button } from "../../components/ui/button";
import { Skeleton } from "../../components/ui/skeleton";
import { formatBytes } from "../../lib/attachmentUpload";
import { registry } from "../../lib/connection";
import { dayTime } from "../../lib/duration";
import { refusalWords } from "../../lib/settingsHome";
import { bytesOfBase64 } from "./fileText";
import { KindGlyph } from "./KindGlyph";
import { pageWidth, readsAsText, useArchive, usePreviewPage, useTextHead, type ArchiveView, type PictureFrom } from "./previews";

/**
 * A file shown read only (docs/DESIGN.md "The Files place", Quick Look's renderer): its pages, its picture, a
 * player for a sound or a video, a zip's listing, else its facts and the one sentence that says why there is no
 * picture. Quick Look, Gallery, Beside and the last column all draw this. It mounts no editor and writes nothing
 * to a host. A file kept in the cloud shows its facts and one press, Download and look: nothing downloads
 * without it.
 */

/** A sound or a video up to this size is played here: its bytes are read into the window on his press. */
export const PLAY_MOST = 200 * 1024 * 1024;

const MEDIA_TYPE: Record<string, string> = {
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  aac: "audio/aac",
  wav: "audio/wav",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  opus: "audio/ogg",
  flac: "audio/flac",
  mp4: "video/mp4",
  m4v: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
};

/** A file's facts in one sentence: what it is, how big, when it changed ("Sheet, 2 KB, changed Nov 3, 2:14 PM"). */
export const factsLine = (entry: Pick<FileEntry, "kind" | "size" | "changed">, when: (at: number) => string = dayTime): string =>
  [ENTRY_KIND_WORDS[entry.kind], entry.size !== undefined ? formatBytes(entry.size) : null, entry.changed ? `changed ${when(entry.changed)}` : null].filter(Boolean).join(", ");

/** No picture: the kind's glyph large, the facts, the one sentence, and a press where there is one. */
function Plain({ entry, why, children }: { entry: FileEntry; why?: string; children?: ReactNode }) {
  return (
    <div data-files-preview-plain className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
      <KindGlyph kind={entry.kind} className="size-10 shrink-0" />
      <div className="flex max-w-sm min-w-0 flex-col gap-1">
        <p className="text-[13px] leading-5 text-muted-foreground tabular-nums">{factsLine(entry)}</p>
        {why ? <p className="text-[13px] leading-5 text-muted-foreground">{why}</p> : null}
      </div>
      {children}
    </div>
  );
}

/** One page: its picture inside the image outline, or bones in a page's shape while it is drawn. */
function Page({ from, entry, page, width, picture, onPages }: { from: PictureFrom; entry: FileEntry; page: number; width: number; picture: boolean; onPages?(pages: number): void }) {
  const view = usePreviewPage(from, entry, page, width);
  const pages = view.is === "page" ? view.pages : 0;
  useEffect(() => {
    if (pages) onPages?.(pages);
    // `onPages` is the caller's newest each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pages]);
  if (view.is === "none") return page === 1 ? <Plain entry={entry} why={view.why} /> : null;
  if (view.is === "loading") return <Skeleton aria-label="Loading" className={picture ? "aspect-[4/3] w-full max-w-xl rounded-md" : "aspect-[17/22] w-full max-w-xl rounded-sm"} />;
  return (
    <img
      src={view.url}
      alt={picture ? entry.name : `${entry.name}, page ${page}`}
      width={view.width}
      height={view.height}
      draggable={false}
      className={`h-auto rounded-sm outline-1 -outline-offset-1 outline-(--image-outline) select-none ${picture ? "max-h-full w-auto max-w-full object-contain" : "w-full max-w-3xl"}`}
    />
  );
}

/** The pages of a file, down the pane: the first two at once, the next as he nears the end of what is drawn. */
function Pages({ from, entry }: { from: PictureFrom; entry: FileEntry }) {
  const [box, setBox] = useState<HTMLDivElement | null>(null);
  const [css, setCss] = useState(640);
  const [pages, setPages] = useState(1);
  const [shown, setShown] = useState(2);
  // One picture, or one frame of a video, fits the pane; pages run down it.
  const picture = entry.kind === "picture" || entry.kind === "video";
  useEffect(() => {
    if (!box) return;
    const measure = (): void => {
      if (box.clientWidth > 0) setCss(box.clientWidth - 32);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(box);
    return () => observer.disconnect();
  }, [box]);
  // Two more pages as the end of what is drawn comes within a pane of sight: on a scroll, and at once where the
  // pages drawn already end in sight (a short landscape file, a pane made taller), so there is always a way on.
  useEffect(() => {
    if (!box || shown >= pages) return;
    const near = (): void => {
      if (box.clientHeight > 0 && box.scrollHeight - box.scrollTop - box.clientHeight < box.clientHeight) setShown((n) => Math.min(pages, n + 2));
    };
    near();
    box.addEventListener("scroll", near, { passive: true });
    return () => box.removeEventListener("scroll", near);
  }, [box, shown, pages, css]);
  const width = pageWidth(css);
  const count = picture ? 1 : Math.min(pages, shown);
  return (
    <div ref={setBox} data-files-preview-pages className={`flex min-h-0 flex-1 flex-col items-center gap-3 p-4 ${picture ? "justify-center overflow-hidden" : "overflow-x-hidden overflow-y-auto"}`}>
      {Array.from({ length: count }, (_, i) => (
        <Page key={i} from={from} entry={entry} page={i + 1} width={width} picture={picture} {...(i === 0 ? { onPages: setPages } : {})} />
      ))}
    </div>
  );
}

/**
 * A text file's first lines, read only, in the mono face on a page of its own: what the `file` kind would show,
 * without its editor. A file the kind only tries as text shows its facts until its bytes read as text.
 */
function TextPage({ from, entry }: { from: PictureFrom; entry: FileEntry }) {
  const head = useTextHead(from, entry);
  if (head.is === "none" || (head.is === "loading" && entry.kind !== "text")) return <Plain entry={entry} />;
  return (
    <div data-files-preview-text className="flex min-h-0 flex-1 flex-col items-center overflow-x-hidden overflow-y-auto p-4">
      {head.is === "loading" ? (
        <Skeleton aria-label="Loading" className="aspect-[17/22] w-full max-w-3xl shrink-0 rounded-sm" />
      ) : (
        <pre className="w-full max-w-3xl shrink-0 rounded-sm bg-background p-6 font-mono text-xs leading-5 break-words whitespace-pre-wrap text-foreground outline-1 -outline-offset-1 outline-(--image-outline)">{head.text}</pre>
      )}
    </div>
  );
}

/** A zip's listing: each thing by its path inside it, with its size. Nothing is extracted. */
export function ArchiveList({ view }: { view: ArchiveView }) {
  if (view.is === "loading")
    return (
      <div role="status" aria-label="Loading" aria-busy className="flex w-full max-w-2xl flex-col p-4">
        {["w-[46%]", "w-[62%]", "w-[38%]", "w-[54%]"].map((w, i) => (
          <div key={i} className="flex h-7 items-center gap-2 px-2">
            <Skeleton className="size-4 shrink-0 rounded-sm" />
            <Skeleton className={`h-3 ${w}`} />
          </div>
        ))}
      </div>
    );
  if (view.is === "failed") return <p className="p-6 text-center text-[13px] text-muted-foreground">{view.why}</p>;
  if (!view.entries.length) return <p className="p-6 text-center text-[13px] text-muted-foreground">Nothing is listed in it.</p>;
  return (
    <div data-files-archive role="list" aria-label="In this archive" className="flex w-full max-w-2xl flex-col p-2">
      {view.entries.map((row) => (
        <div key={row.name} role="listitem" className="flex h-7 shrink-0 items-center gap-2 px-2 text-[13px]">
          <KindGlyph kind={row.dir ? "folder" : "other"} tinted={row.dir} />
          <span className="min-w-0 flex-1 truncate text-foreground" style={{ direction: "rtl", textAlign: "left" }}>
            <bdi>{row.name}</bdi>
          </span>
          {row.dir ? null : <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{formatBytes(row.size)}</span>}
        </div>
      ))}
      {view.more ? <p className="px-2 pt-2 text-xs text-muted-foreground">It holds more than are listed here.</p> : null}
    </div>
  );
}

/** A file's bytes read whole into the window, a part at a time, by the version the first part named. */
export async function readWhole(from: PictureFrom, entry: FileEntry, signal: { stopped: boolean }, onPart?: (read: number) => void, itemId?: string): Promise<Blob | null> {
  const parts: BlobPart[] = [];
  let version: string | undefined;
  for (let offset = 0; ; ) {
    if (signal.stopped) return null;
    const got = await registry.linkOf(from.copy.link).request<FileBytes>("work.files.read", { workspaceId: from.workspaceId, ref: entry.ref, ...(itemId ? { itemId } : {}), offset, length: 4 * 1024 * 1024, ...(version ? { version } : {}) });
    const bytes = bytesOfBase64(got.data);
    parts.push(bytes as BlobPart);
    version = got.version;
    offset += bytes.length;
    onPart?.(offset);
    if (got.end || bytes.length === 0) break;
  }
  return signal.stopped ? null : new Blob(parts, { type: MEDIA_TYPE[extOf(entry.name)] ?? "" });
}

/**
 * A sound or a video played here: nothing is read until he presses Play, then its bytes come into the window
 * and the system's own controls play them. The address is let go when the file leaves the pane.
 */
export function MediaPlay({ from, entry, itemId, still, read = readWhole }: { from: PictureFrom; entry: FileEntry; itemId?: string; /** what stands there until he plays it: a video's frame */ still?: ReactNode; read?: typeof readWhole }) {
  const [state, setState] = useState<{ is: "idle" } | { is: "reading"; read: number } | { is: "playing"; url: string } | { is: "failed"; why: string }>({ is: "idle" });
  const stop = useRef({ stopped: false });
  useEffect(() => {
    const signal = stop.current;
    return () => {
      signal.stopped = true;
    };
  }, []);
  const url = state.is === "playing" ? state.url : null;
  useEffect(() => (url ? () => URL.revokeObjectURL(url) : undefined), [url]);
  const video = entry.kind === "video";
  const tooBig = (entry.size ?? 0) > PLAY_MOST;
  const play = (): void => {
    setState({ is: "reading", read: 0 });
    void read(from, entry, stop.current, (n) => setState({ is: "reading", read: n }), itemId).then(
      (blob) => blob && setState({ is: "playing", url: URL.createObjectURL(blob) }),
      (err: unknown) => setState({ is: "failed", why: refusalWords(err) || "The host did not answer." }),
    );
  };
  if (state.is === "playing")
    return (
      <div data-files-player className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 p-4">
        {video ? (
          // eslint-disable-next-line jsx-a11y/media-has-caption
          <video src={state.url} controls autoPlay className="max-h-full max-w-full rounded-md outline-1 -outline-offset-1 outline-(--image-outline)" />
        ) : (
          <>
            <KindGlyph kind="audio" className="size-10 shrink-0" />
            {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
            <audio src={state.url} controls autoPlay className="w-full max-w-md" />
          </>
        )}
      </div>
    );
  const percent = state.is === "reading" && entry.size ? Math.min(100, Math.round((state.read / entry.size) * 100)) : 0;
  const press = tooBig ? null : (
    <Button variant="secondary" size="sm" data-files-play disabled={state.is === "reading"} onClick={play}>
      <BusyLabel busy={state.is === "reading"} label={state.is === "reading" ? `Reading ${percent}%` : "Play"} />
    </Button>
  );
  // A video stands as its frame until he plays it, the press under the frame.
  if (still && state.is !== "failed" && !tooBig)
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        {still}
        <div className="flex shrink-0 justify-center pb-4">{press}</div>
      </div>
    );
  return (
    <Plain entry={entry} why={state.is === "failed" ? state.why : tooBig ? "It is too large to play here." : undefined}>
      {press}
    </Plain>
  );
}

export function FilePreviewPane({
  from,
  entry,
  onFetch,
  fetchLabel = "Download and Look",
}: {
  /** where the file's pictures are asked; null where there is no host to ask (its facts alone are shown) */
  from: PictureFrom | null;
  entry: FileEntry;
  /** the press for a file kept in the cloud, in the words of where it is shown */
  fetchLabel?: string;
  /** Download and look: brings a file kept in the cloud onto its computer; absent, the press is not offered */
  onFetch?(entry: FileEntry): Promise<void>;
}) {
  // A file fetched on his press is looked at from then on, before its folder is listed again.
  const [fetched, setFetched] = useState<string | null>(null);
  const [fetching, setFetching] = useState<{ key: string; why?: string } | null>(null);
  const cloud = (entry.local === false || entry.state?.is === "cloud") && fetched !== entry.key;
  const archive = useArchive(from, entry, !cloud && entry.kind === "archive" && !!from && from.copy.wire === "files");
  let body: ReactNode;
  if (!entry.ref) body = <Plain entry={entry} />;
  else if (cloud) {
    const mine = fetching?.key === entry.key ? fetching : null;
    body = (
      <Plain entry={entry} why={mine?.why ?? "It is kept in the cloud."}>
        {onFetch ? (
          <Button
            variant="secondary"
            size="sm"
            data-files-fetch
            disabled={!!mine && !mine.why}
            onClick={() => {
              setFetching({ key: entry.key });
              void onFetch(entry).then(
                () => {
                  setFetched(entry.key);
                  setFetching(null);
                },
                (err: unknown) => setFetching({ key: entry.key, why: refusalWords(err) || "It did not download." }),
              );
            }}
          >
            <BusyLabel busy={!!mine && !mine.why} label={fetchLabel} />
          </Button>
        ) : null}
      </Plain>
    );
  } else if (!from || from.copy.wire !== "files") body = <Plain entry={entry} />;
  else if (from.copy.place.vm) body = <Plain entry={entry} why="It is in the Windows VM." />;
  else if (entry.kind === "audio") body = <MediaPlay key={entry.key} from={from} entry={entry} />;
  else if (entry.kind === "archive") body = <div className="flex min-h-0 flex-1 flex-col items-center overflow-x-hidden overflow-y-auto">{extOf(entry.name) === "zip" ? <ArchiveList view={archive} /> : <Plain entry={entry} />}</div>;
  else if (entry.kind === "video") body = <MediaPlay key={entry.key} from={from} entry={entry} still={<Pages from={from} entry={entry} />} />;
  else if (readsAsText(entry)) body = <TextPage key={entry.key} from={from} entry={entry} />;
  else if (entry.kind === "other") body = <Plain entry={entry} />;
  else body = <Pages key={entry.key} from={from} entry={entry} />;
  return (
    <div data-files-preview={entry.key} className="flex min-h-0 min-w-0 flex-1 flex-col bg-(--stage)">
      {body}
    </div>
  );
}
