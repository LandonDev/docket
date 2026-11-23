import { useCallback, useEffect, useState } from "react";
import type { GoogleFileState, GooglePush } from "@shared/contract-work-google";
import type { DeckView } from "@shared/contract-work-slides";
import type { CanvasItem } from "@shared/work";
import { Copy, ExternalLink, RefreshCw } from "../../chrome/icons";
import { BusyLabel, Button } from "../../components/ui/button";
import { registry } from "../../lib/connection";
import { openUrl } from "../../lib/native";
import type { CanvasShell, MoreEntry } from "../canvas/kind";
import { sayError } from "../canvas/frame";
import { Export } from "../icons";
import { feedMore } from "./more";
import { UploadGoogleDialog } from "../google/UploadGoogleDialog";

/** A Files tab's owner, as `filesPaneOf` names it. Said here because @shared/work's module holds zod schemas, which this canvas's chunk must not take (pdf/firstPaint.test.ts); formats.test.ts holds the two equal. */
export const FILES_PANE = "filespane_";

/** The notice line's words and its one press, as the body draws them. */
export interface SlideNotice {
  /** null: the line says nothing the bar has not (a mail's file in a Files tab is "Read only" in its header). */
  words: string | null;
  press: { label: string; run(): Promise<void> } | null;
}

/**
 * What a read-only deck says above the stage (docs/DESIGN.md "Slides from other formats"): an import or a Google
 * deck is "Read only" with Make a copy to edit; a Google deck someone changed in Drive since it was read says so
 * with Read again; one Drive could not be reached for shows the copy read before and says that instead.
 */
export function noticeOf(item: Pick<CanvasItem, "source" | "sessionId">, readOnly: DeckView["readOnly"], behind: boolean, copy: () => Promise<void>, readAgain: () => Promise<void>): SlideNotice | null {
  if (!readOnly) return null;
  if (readOnly.from === "google" && behind) return { words: "Changed in Google", press: { label: "Read again", run: readAgain } };
  if (readOnly.from === "google" && readOnly.offline) return { words: "Couldn't reach Google", press: { label: "Read again", run: readAgain } };
  const saidAbove = item.source.at === "mail" && item.sessionId.startsWith(FILES_PANE);
  return { words: saidAbove ? null : "Read only", press: { label: "Make a copy to edit", run: copy } };
}

/**
 * The deck's file verbs: its rows of the pane's More (Save to Google Slides; for a read-only deck Make a copy to
 * edit, and a Google deck's Read again and Open in Google), the upload dialog, and the notice line's state. A
 * Google deck hears of a change in Drive through the `work.google` push for its item.
 */
export function useSlideFileActions({ env, item, shell, refresh, view }: { env: string; item: CanvasItem; shell: CanvasShell; refresh(): Promise<void>; view: DeckView | null }) {
  const [upload, setUpload] = useState(false);
  const [behind, setBehind] = useState(false);
  const googleId = item.source.at === "google" ? item.source.fileId : null;
  const { id } = item;
  const readOnly = view?.readOnly;
  const canUpload = view?.canUpload === true;

  useEffect(() => {
    if (!googleId) return;
    const link = registry.linkOf(env);
    let live = true;
    const take = (state: GoogleFileState) => live && setBehind(state.behind);
    void link.request<GoogleFileState>("work.google.watch", { itemId: id }).then(take, () => {});
    const off = link.onPush((push) => {
      const p = push as GooglePush;
      if (p.push === "work.google" && p.itemId === id) take(p.state);
    });
    return () => {
      live = false;
      off();
    };
  }, [env, googleId, id]);

  const copy = useCallback(async () => {
    await registry.linkOf(env).request("work.slides.copyToEdit", { itemId: id });
  }, [env, id]);
  const readAgain = useCallback(async () => {
    await registry.linkOf(env).request<GoogleFileState>("work.google.reload", { itemId: id });
    setBehind(false);
    await refresh();
  }, [env, id, refresh]);

  useEffect(() => {
    const rows: MoreEntry[] = [];
    if (googleId) {
      rows.push(
        { id: "google-reload", label: "Read again from Google", icon: RefreshCw, run: readAgain },
        { id: "google-open", label: "Open in Google", icon: ExternalLink, run: () => openUrl(`https://docs.google.com/presentation/d/${encodeURIComponent(googleId)}/edit`) },
      );
    }
    if (readOnly) rows.push({ id: "copy-to-edit", label: "Make a copy to edit", icon: Copy, run: copy });
    if (canUpload) rows.push({ id: "google-upload", label: "Save to Google Slides", icon: Export, run: () => setUpload(true) });
    feedMore(shell, "file", rows.length ? rows : null);
    return () => feedMore(shell, "file", null);
  }, [shell, googleId, readOnly, canUpload, copy, readAgain]);

  return {
    dialog: upload && canUpload ? <UploadGoogleDialog env={env} itemId={id} kind="Slides" onClose={() => setUpload(false)} /> : null,
    notice: noticeOf(item, readOnly, behind, copy, readAgain),
  };
}

/** The line under the format row: quiet words, then its press, which says it is busy while it runs. */
export function NoticeLine({ notice }: { notice: SlideNotice }) {
  const [busy, setBusy] = useState(false);
  const press = notice.press;
  const run = () => {
    if (!press || busy) return;
    setBusy(true);
    void press.run().then(
      () => setBusy(false),
      (e: unknown) => (setBusy(false), sayError(e, `Couldn't ${press.label.toLowerCase()}`)),
    );
  };
  return (
    <div data-slide-notice className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1 text-xs text-muted-foreground">
      {notice.words ? <span className="min-w-0 truncate">{notice.words}</span> : null}
      {press ? (
        <Button variant="link" size="xs" className="h-auto shrink-0 px-0 text-xs" disabled={busy} onClick={run}>
          <BusyLabel busy={busy} label={press.label} />
        </Button>
      ) : null}
    </div>
  );
}
