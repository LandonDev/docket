import { lazy, Suspense, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { FileBytes } from "@shared/contract-work-files";
import { canvasSourcePath, filesPaneWorkspace } from "@shared/work";
import { extOf, kindOfEntry, type FileEntry } from "@shared/work/files";
import { BusyLabel, Button } from "../../components/ui/button";
import { loadToast } from "../../components/ui/toaster";
import { registry } from "../../lib/connection";
import { refusalWords } from "../../lib/settingsHome";
import { sessionStore } from "../../lib/tcserver/store";
import { EmptyState } from "../../surfaces/SurfaceSkeleton";
import { ItemSkeleton } from "../canvas/ItemBones";
import type { CanvasBodyProps } from "../canvas/kind";
import { FileSession } from "./fileSession";
import { bytesOfBase64, whenWords } from "./fileText";
import { KindGlyph } from "./KindGlyph";
import { ArchiveList, factsLine, MediaPlay } from "./Preview";
import { hostFrom, useArchive } from "./previews";

/**
 * The file kind's body (docs/agents/work-files.md "The file kind", docs/DESIGN.md "The Files place"): a text or
 * code file in an editor that saves as he types, a sound with its player, a zip with the list of what it holds,
 * or a file's facts with the ways out of here. It has no bar of
 * its own: the save line under the file's name says where saving stands.
 */

/** The workspace an item's files are asked in: the Files pane's own, else its thread's. */
const workspaceOf = (owner: string): string | null => filesPaneWorkspace(owner) ?? sessionStore.metaOf(owner)?.workspaceId ?? null;

export function Body({ item, source, env, shell }: CanvasBodyProps<undefined>) {
  const workspaceId = workspaceOf(item.sessionId);
  const session = useMemo(() => {
    if (!workspaceId) return null;
    const link = registry.linkOf(env);
    return new FileSession(
      {
        request: (method, params) => link.request(method, params),
        saved: (line) => shell.saved?.(line),
        say: (text) => void loadToast().then((toast) => toast.message(text)),
      },
      { workspaceId, itemId: item.id, source, name: item.title },
    );
    // One session for the item's life: its source never changes under one id.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [env, item.id, workspaceId]);
  const view = useSyncExternalStore(session?.subscribe ?? noSubscribe, session?.getSnapshot ?? loadingView);

  useEffect(() => {
    if (!session || !workspaceId) return;
    void session.load();
    // A change in the file's folder, and the window coming forward, are when a second writer shows.
    const look = (): void => void session.check();
    const off = registry.linkOf(env).onPush((push) => {
      if (push.push === "work.files" && push.workspaceId === workspaceId && push.at !== undefined) look();
    });
    window.addEventListener("focus", look);
    return () => {
      off();
      window.removeEventListener("focus", look);
      // A tab can close under the editor, from this window or another: what waits is sent.
      session.dispose();
    };
  }, [session, env, workspaceId]);

  useEffect(() => {
    shell.ready?.(view.is === "text" || view.is === "facts");
    if (view.is === "failed") shell.statusLine({ tone: "failed", word: "This file could not be read", detail: view.error, action: { label: "Retry", run: () => session?.load() } });
    else shell.statusLine(null);
  }, [view, shell, session]);

  if (!workspaceId) return <EmptyState title="This file has no workspace" />;
  if (view.is === "loading" || !session) return <ItemSkeleton />;
  if (view.is === "failed") return null;
  if (view.is === "facts") return <Facts name={item.title} entry={view.entry} why={view.why} env={env} workspaceId={workspaceId} itemId={item.id} source={source} />;
  return (
    <Suspense fallback={<ItemSkeleton />}>
      <TextEditor key={view.rev} name={item.title} path={canvasSourcePath(source) ?? item.title} text={view.text} readOnly={view.locked !== null} onChange={(text) => session.edit(text)} />
    </Suspense>
  );
}

/** The editor is CodeMirror, which a file shown as its facts never needs: it loads when the first text does. */
const TextEditor = lazy(() => import("./FileTextEditor").then((m) => ({ default: m.FileTextEditor })));

const noSubscribe = (): (() => void) => () => undefined;
const LOADING = { is: "loading" } as const;
const loadingView = (): typeof LOADING => LOADING;

/** A file's facts, for one no editor here shows: what it is, how big, when it changed, and the ways out. */
export function Facts({ name, entry, why, env, workspaceId, itemId, source }: { name: string; entry: FileEntry | null; why?: string; env: string; workspaceId: string; itemId: string; source: CanvasBodyProps["source"] }) {
  const kind = kindOfEntry(name).kind;
  const [busy, setBusy] = useState<"app" | "download" | null>(null);
  // One sentence of facts under the header that already names the file: the name is not said again.
  const facts = factsLine({ kind, ...(entry?.size !== undefined ? { size: entry.size } : {}), ...(entry?.changed ? { changed: entry.changed } : {}) }, whenWords);
  // The host is asked only on a press: a facts page drawn with no host (a preview) still draws.
  const link = (): ReturnType<typeof registry.linkOf> => registry.linkOf(env);
  // Its own app can be asked for a file in a library, on the computer it lies on; a download takes its bytes from the disk they are on.
  const inLibrary = entry?.shared === true;
  const cloudOnly = entry?.local === false;
  const run = (what: "app" | "download", fn: () => Promise<void>): void => {
    if (busy) return;
    setBusy(what);
    void fn()
      .catch((err: unknown) => void loadToast().then((toast) => toast.error(what === "app" ? `${name} did not open` : `${name} did not download`, { description: refusalWords(err) || undefined })))
      .finally(() => setBusy(null));
  };
  const download = async (): Promise<void> => {
    const parts: BlobPart[] = [];
    let version: string | undefined;
    for (let offset = 0; ; ) {
      const got = await link().request<FileBytes>("work.files.read", { workspaceId, ref: source, itemId, offset, length: 4 * 1024 * 1024, ...(version ? { version } : {}) });
      const bytes = bytesOfBase64(got.data);
      parts.push(bytes as BlobPart);
      version = got.version;
      offset += bytes.length;
      if (got.end || bytes.length === 0) break;
    }
    const url = URL.createObjectURL(new Blob(parts));
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  };
  // A sound is played here and a zip lists what it holds: both read the file where it lies, on a press or as its listing alone.
  const here = entry && !cloudOnly ? { ...entry, ref: source } : null;
  const sound = here && kind === "audio" ? here : null;
  const zip = here && extOf(name) === "zip" ? here : null;
  const from = useMemo(() => hostFrom(env, workspaceId), [env, workspaceId]);
  const archive = useArchive(zip ? from : null, zip, !!zip);
  const ways = entry ? (
    <div className="flex items-center gap-2">
      {inLibrary ? (
        <Button variant="secondary" size="sm" disabled={busy !== null} onClick={() => run("app", () => link().request("work.office.filesOpen", { source }).then(() => undefined))}>
          <BusyLabel busy={busy === "app"} label="Open in its app" />
        </Button>
      ) : null}
      {!cloudOnly ? (
        <Button variant={inLibrary || sound ? "ghost" : "secondary"} size="sm" disabled={busy !== null} onClick={() => run("download", download)}>
          <BusyLabel busy={busy === "download"} label="Download" />
        </Button>
      ) : null}
    </div>
  ) : null;
  if (sound)
    return (
      <div data-file-facts="audio" className="flex min-h-0 flex-1 flex-col bg-background">
        <MediaPlay from={from} entry={sound} itemId={itemId} />
        <div className="flex shrink-0 justify-center pb-8">{ways}</div>
      </div>
    );
  const about = (
    <>
      <KindGlyph kind={kind} className="size-10 shrink-0" />
      <div className="flex max-w-md min-w-0 flex-col gap-1">
        {facts ? <p className="text-sm text-muted-foreground">{facts}</p> : null}
        {why ? <p className="text-sm text-muted-foreground">{why}</p> : null}
        {entry === null ? <p className="text-sm text-muted-foreground">It is not where it was.</p> : null}
      </div>
      {ways}
    </>
  );
  if (zip)
    return (
      <div data-file-facts="archive" className="flex min-h-0 flex-1 flex-col items-center overflow-x-hidden overflow-y-auto bg-background">
        <div className="flex shrink-0 flex-col items-center gap-4 px-8 pt-8 pb-4 text-center">{about}</div>
        <ArchiveList view={archive} />
      </div>
    );
  return (
    <div data-file-facts className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 overflow-auto bg-background p-8 text-center">
      {about}
    </div>
  );
}
