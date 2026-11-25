import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import type { CanvasSource } from "@shared/work";
import { Check, Copy } from "../../chrome/icons";
import { SwapIcon } from "../../motion/IconSwap";
import { Share as ShareGlyph } from "../icons";
import { ModalPanel, useClosingDialog } from "../../chrome/Modal";
import { DialogFooter, ErrorLine } from "../../chrome/ConfirmDialog";
import { Button } from "../../components/ui/button";
import { Dialog } from "../../components/ui/dialog";
import { copyText } from "../../lib/clipboard";
import { dayOf, filePageOf, mayHavePage, ROLE_WORDS, shareHomeOf, shareTargetOf, type GuestLinkRow } from "./api";
import { openUrl } from "../../lib/native";
import { useShareAsked } from "./sharePort";
import type { ShareTarget } from "./ShareSheet";

const ShareSheet = lazy(() => import("./ShareSheet"));

/**
 * Share in a document's or a sheet's header (docs/DESIGN.md "Share"): a ghost extra-small verb that opens the one
 * Share sheet (ShareSheet.tsx, its own chunk, loaded on the press). File → Share… and More reach the same sheet
 * through `openShare(itemId)`. A LifeOS document or sheet and a TempCode one kept as a file make links; any other
 * document or sheet opens the sheet on the one line that says what to do instead; a mail's attachment draws none.
 */
export function ShareButton({ env, source, kind, title, itemId, workspaceId, purdue = false }: { env: string; source: CanvasSource; kind: "document" | "sheet"; title: string; itemId?: string; /** the workspace the item is of: a file a library shows on its own page is shared there */ workspaceId?: string | null; purdue?: boolean }) {
  const key = JSON.stringify(source);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- the source by its value: a new object each render is the same source.
  const target = useMemo(() => shareTargetOf(source, kind), [key, kind]);
  // A file whose library shows it on its own web page is shared there: the host is asked once, and the button waits.
  const asks = !!workspaceId && source.at === "file" && mayHavePage(source.path);
  const [page, setPage] = useState<{ key: string; url: string | null } | null>(null);
  useEffect(() => {
    if (!asks) return;
    let live = true;
    void filePageOf(env, workspaceId!, source).then((url) => live && setPage({ key, url }));
    return () => void (live = false);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the source by its value
  }, [asks, env, workspaceId, key]);
  if (asks && page?.key !== key) return null;
  if (asks && page?.url) return <ShareInHome url={page.url} itemId={itemId} />;
  return target ? <ShareOpener env={env} target={target} title={title} itemId={itemId} purdue={purdue} /> : null;
}

/** Share in Teams (or OneDrive): the file's own page in his browser, where Teams shares it; File → Share… opens it too. */
function ShareInHome({ url, itemId }: { url: string; itemId?: string | undefined }) {
  const asked = useShareAsked(itemId);
  const seen = useRef(asked);
  useEffect(() => {
    if (asked === seen.current) return;
    seen.current = asked;
    void openUrl(url);
  }, [asked, url]);
  return (
    <Button data-share-button="" data-share-home="" variant="ghost" size="xs" className="ms-auto" onClick={() => void openUrl(url)}>
      <ShareGlyph />
      Share in {shareHomeOf(url)}
    </Button>
  );
}

/** Share on a project's bar (the Projects view): the same sheet, for a link that can only view. One of the bar's quiet 28px verbs. */
export function ProjectShare({ env, project }: { env: string; project: { id: string; name: string } }) {
  const target = useMemo<ShareTarget>(() => ({ source: { at: "lifeos", table: "projects", id: project.id } }), [project.id]);
  return <ShareOpener env={env} target={target} title={project.name} size="sm" />;
}

function ShareOpener({ env, target, title, itemId, purdue = false, size = "xs" }: { env: string; target: ShareTarget; title: string; itemId?: string; purdue?: boolean; size?: "xs" | "sm" }) {
  const [open, setOpen] = useState(false);
  const asked = useShareAsked(itemId);
  const seen = useRef(asked);
  useEffect(() => {
    if (asked === seen.current) return;
    seen.current = asked;
    setOpen(true);
  }, [asked]);
  return (
    <>
      <Button data-share-button="" variant="ghost" size={size} className={size === "xs" ? "ms-auto" : undefined} onClick={() => setOpen(true)}>
        <ShareGlyph />
        Share
      </Button>
      {open ? (
        <Suspense fallback={null}>
          <ShareSheet env={env} target={target} title={title} purdue={purdue} onClose={() => setOpen(false)} />
        </Suspense>
      ) : null}
    </>
  );
}

/**
 * A link's address, shown once: read only and selectable, with Copy, and what
 * the guest may do until when. A copy that fails says so here, and the address
 * stays to select by hand. Used by a new link and by Settings' Replace address
 * when its copy failed.
 */
export function MadeAddress({ url, link }: { url: string; link: Pick<GuestLinkRow, "name" | "role" | "expiresAt"> }) {
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const copy = async (): Promise<void> => {
    try {
      await copyText(url);
      setCopyError(false);
      setCopied(true);
    } catch {
      setCopyError(true);
    }
  };
  return (
    <div className="flex flex-col gap-2 px-5 py-4">
      <div className="flex h-9 min-w-0 items-center gap-2 rounded-lg border border-input ps-3 pe-1">
        <span className="min-w-0 flex-1 truncate font-mono text-xs select-all">{url}</span>
        <Button variant="ghost" size="xs" onClick={() => void copy()}>
          <SwapIcon swapped={copied} from={<Copy />} to={<Check />} />
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      {copyError ? <ErrorLine error="It didn't copy. Select the address to copy it." /> : null}
      <p className="text-xs text-muted-foreground">
        {link.name} can {ROLE_WORDS[link.role].toLowerCase()} until {dayOf(link.expiresAt)}. This address is shown only now.
      </p>
    </div>
  );
}

/** The link-made dialog alone: Settings' Replace address opens it when the new address did not copy. */
export function MadeLinkDialog({ url, link, title, onClose }: { url: string; link: Pick<GuestLinkRow, "name" | "role" | "expiresAt">; title: string; onClose(): void }) {
  const { root, closeThen } = useClosingDialog(onClose, false);
  return (
    <Dialog {...root}>
      <ModalPanel onClose={() => closeThen(onClose)} title={`Link for ${link.name}`} description={title} size="sm">
        <MadeAddress url={url} link={link} />
        <DialogFooter confirmLabel="Done" onConfirm={() => closeThen(onClose)} />
      </ModalPanel>
    </Dialog>
  );
}
