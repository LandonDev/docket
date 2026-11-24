import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CanvasSource } from "@shared/work";
import { Check, Copy } from "../../chrome/icons";
import { SwapIcon } from "../../motion/IconSwap";
import { Share as ShareGlyph } from "../icons";
import { ModalPanel, useClosingDialog } from "../../chrome/Modal";
import { DialogFooter, ErrorLine } from "../../chrome/ConfirmDialog";
import { hostFailure } from "../../lib/hostFailure";
import { BusyLabel, Button } from "../../components/ui/button";
import { Dialog } from "../../components/ui/dialog";
import { Skeleton } from "../../components/ui/skeleton";
import { Face } from "../mail/face";
import { copyText } from "../../lib/clipboard";
import { cn } from "../../lib/cn";
import { reveal, yields } from "../../components/ui/reveal";
import { dayOf, guestsCall, isLive, ROLE_WORDS, shareTargetOf, shortDay, type GuestLinkRow, type GuestSource } from "./api";
import { useShareAsked } from "./sharePort";
import type { ShareTarget } from "./ShareSheet";

const ShareSheet = lazy(() => import("./ShareSheet"));

/**
 * Share in a document's or a sheet's header (docs/DESIGN.md "Share"): a ghost extra-small verb that opens the one
 * Share sheet (ShareSheet.tsx, its own chunk, loaded on the press). File → Share… and More reach the same sheet
 * through `openShare(itemId)`. A LifeOS document or sheet and a TempCode one kept as a file make links; any other
 * document or sheet opens the sheet on the one line that says what to do instead; a mail's attachment draws none.
 */
export function ShareButton({ env, source, kind, title, itemId, purdue = false }: { env: string; source: CanvasSource; kind: "document" | "sheet"; title: string; itemId?: string; purdue?: boolean }) {
  const key = JSON.stringify(source);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- the source by its value: a new object each render is the same source.
  const target = useMemo(() => shareTargetOf(source, kind), [key, kind]);
  return target ? <ShareOpener env={env} target={target} title={title} itemId={itemId} purdue={purdue} /> : null;
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

/** Sharing in a Work project's settings: its guest links in the sheet itself, Revoke on hover, and New guest link…, which opens the Share sheet. */
export function ProjectSharing({ env, projectId, title }: { env: string; projectId: string; title: string }) {
  const target = useMemo<GuestSource>(() => ({ at: "lifeos", table: "projects", id: projectId }), [projectId]);
  const [making, setMaking] = useState(false);
  // The list is read again once the sheet closes, a link made or not.
  const [made, setMade] = useState(0);
  return (
    <div data-project-sharing className="-mx-2">
      <ItemLinks key={made} env={env} source={target} layout="section" onNew={() => setMaking(true)} />
      {making ? (
        <Suspense fallback={null}>
          <ShareSheet
            env={env}
            target={{ source: target }}
            title={title}
            onClose={() => {
              setMaking(false);
              setMade((n) => n + 1);
            }}
          />
        </Suspense>
      ) : null}
    </div>
  );
}

function ItemLinks({ env, source, layout, onNew }: { env: string; source: GuestSource; layout?: "menu" | "section"; onNew(): void }) {
  const [rows, setRows] = useState<GuestLinkRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // A revoke's own refusal: kept apart from the list's read, so a reload never wipes it.
  const [refused, setRefused] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [home, setHome] = useState(env);
  // Retry keeps its row, and the focus on it, busy until the read settles; the first read has no row to keep.
  const [retrying, setRetrying] = useState(false);
  const load = useCallback(
    (again = false) => {
      if (again) setRetrying(true);
      else setError(null);
      guestsCall<GuestLinkRow[]>(env, "work.guests.forItem", { source })
        .then(
          (got) => {
            setError(null);
            setHome(got.env);
            setRows((got.value ?? []).filter((l) => isLive(l)));
          },
          (err: unknown) => setError(hostFailure(env, err, "could not list the guest links")),
        )
        .finally(() => setRetrying(false));
    },
    [env, source],
  );
  useEffect(() => load(), [load]);
  // The row stays, its Revoke busy, until the host confirms; refused, it stays and says why.
  const revoke = async (id: string): Promise<void> => {
    setRevoking(id);
    setRefused(null);
    try {
      await guestsCall(home, "work.guests.revoke", { linkId: id });
      setRows((now) => now?.filter((l) => l.id !== id) ?? null);
    } catch (err) {
      setRefused(hostFailure(home, err, "did not revoke the link", true));
    } finally {
      setRevoking(null);
    }
  };
  return <LinkRows rows={rows} error={error} refused={refused} revoking={revoking} project={source.at === "lifeos" && source.table === "projects"} layout={layout} onRevoke={(id) => void revoke(id)} onRetry={() => load(true)} retrying={retrying} onNew={onNew} />;
}

/**
 * An item's guest links as rows, with no host behind them: what the popover, the sheet and a
 * preview draw. `rows` null is the read on its way. A project's guest only views, so its row says
 * until when and not what they can do.
 */
export function LinkRows({
  rows,
  error = null,
  refused = null,
  revoking = null,
  project = false,
  layout = "menu",
  onRevoke,
  onRetry,
  retrying = false,
  onNew,
}: {
  rows: GuestLinkRow[] | null;
  error?: string | null;
  refused?: string | null;
  revoking?: string | null;
  project?: boolean;
  /** `menu`: the popover's rows over a full-width New guest link…; `section`: a settings sheet's part, its button at the end of the last line as the sheet's other parts hold theirs */
  layout?: "menu" | "section";
  onRevoke(id: string): void;
  onRetry(): void;
  /** Retry's read is out: the row stays and its button is busy. */
  retrying?: boolean;
  onNew(): void;
}) {
  return (
    <div className="flex flex-col">
      {rows === null && !error ? (
        <div className="flex h-9 items-center px-2">
          <Skeleton className="h-3 w-40" />
        </div>
      ) : null}
      {rows?.length === 0 && layout === "menu" ? <p className="flex h-9 items-center px-2 text-[13px] text-muted-foreground">Only you can open this</p> : null}
      {rows?.map((l) => (
        <div key={l.id} className="group/row flex h-9 min-w-0 items-center gap-2 rounded-lg px-2 text-[13px] hover:bg-foreground/5">
          <Face name={l.name} size="row" />
          <span className="min-w-0 flex-1 truncate">{l.name}</span>
          {/* Revoke takes the facts' place on hover (docs/DESIGN.md "Hover reveal"). */}
          <span className="relative flex shrink-0 items-center justify-end">
            <span className={cn("text-xs text-muted-foreground tabular-nums", revoking === l.id ? "opacity-0" : yields("row"))}>
              {project ? `until ${shortDay(l.expiresAt)}` : `${ROLE_WORDS[l.role]}, until ${shortDay(l.expiresAt)}`}
            </span>
            <span className={cn("absolute end-0", revoking === l.id ? "opacity-100" : reveal("row", { row: true, overlay: true }))}>
              <Button variant="ghost" size="xs" aria-label={`Revoke ${l.name}'s link`} disabled={revoking !== null} onClick={() => onRevoke(l.id)}>
                <BusyLabel busy={revoking === l.id} label="Revoke" />
              </Button>
            </span>
          </span>
        </div>
      ))}
      {refused ? (
        <div className="flex min-h-9 items-center px-2">
          <ErrorLine error={refused} />
        </div>
      ) : null}
      {error ? (
        <div className="flex min-h-9 items-center gap-2 px-2">
          <div className="min-w-0 flex-1">
            <ErrorLine error={error} />
          </div>
          <Button variant="ghost" size="xs" disabled={retrying} onClick={onRetry}>
            <BusyLabel busy={retrying} label="Retry" />
          </Button>
        </div>
      ) : null}
      {layout === "menu" ? (
        <div className="mt-1 border-t border-border pt-1">
          <Button variant="ghost" size="sm" className="w-full justify-start" onClick={onNew}>
            New guest link…
          </Button>
        </div>
      ) : (
        <div className={cn("flex min-h-7 items-center justify-between gap-3 px-2", rows?.length ? "mt-1" : null)}>
          <span className="min-w-0 truncate text-[13px] text-foreground">{rows?.length === 0 ? "Only you can open this" : null}</span>
          <Button type="button" variant="secondary" size="sm" onClick={onNew}>
            New guest link…
          </Button>
        </div>
      )}
    </div>
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
