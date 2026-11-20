import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import type { CanvasSource } from "@shared/work";
import { Check, Copy } from "../../chrome/icons";
import { SwapIcon } from "../../motion/IconSwap";
import { Share as ShareGlyph } from "../icons";
import { ModalPanel, useClosingDialog } from "../../chrome/Modal";
import { Field, FieldRow } from "../../chrome/DialogField";
import { DialogFooter, ErrorLine, errorText } from "../../chrome/ConfirmDialog";
import { ChoiceSelect } from "../../components/choice-select";
import { BusyLabel, Button } from "../../components/ui/button";
import { Dialog } from "../../components/ui/dialog";
import { Input } from "../../components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "../../components/ui/popover";
import { Skeleton } from "../../components/ui/skeleton";
import { ToggleGroup, ToggleGroupItem } from "../../components/ui/toggle-group";
import { copyText } from "../../lib/clipboard";
import { cn } from "../../lib/cn";
import { reveal, yields } from "../../components/ui/reveal";
import { dayOf, ENDS, guestsCall, guestSource, isLive, ROLE_WORDS, shortDay, type GuestCreated, type GuestLinkRow, type GuestRole, type GuestSource } from "./api";

/**
 * Share on a document's or a sheet's bar (prototype guest.html; docs/DESIGN.md
 * "History and Share"): a 320px popover of the item's guest links, Revoke on
 * hover, and New guest link…, which opens one small dialog: who it is for,
 * what they can do, the day it ends. The link is then shown once, to copy.
 * Only a LifeOS document or sheet can be shared from a canvas; any other
 * source draws no Share. A project is shared from its page's bar and its
 * settings (`ProjectShare`, `ProjectSharing`): view only.
 */
export function ShareButton({ env, source, title }: { env: string; source: CanvasSource; title: string }) {
  const target = guestSource(source);
  return target ? <Share env={env} target={target} title={title} /> : null;
}

/** Share on a project's bar (the Projects view): the same popover and dialog, for a link that can only view. One of the bar's quiet 28px verbs. */
export function ProjectShare({ env, project }: { env: string; project: { id: string; name: string } }) {
  const target = useMemo<GuestSource>(() => ({ at: "lifeos", table: "projects", id: project.id }), [project.id]);
  return <Share env={env} target={target} title={project.name} size="sm" />;
}

/** Sharing in a Work project's settings: its guest links in the sheet itself, Revoke on hover, and New guest link…. */
export function ProjectSharing({ env, projectId, title }: { env: string; projectId: string; title: string }) {
  const target = useMemo<GuestSource>(() => ({ at: "lifeos", table: "projects", id: projectId }), [projectId]);
  const [making, setMaking] = useState(false);
  // The list is read again once a link was made, and not for a dialog he cancelled.
  const [made, setMade] = useState(0);
  return (
    <div data-project-sharing className="-mx-2">
      <ItemLinks key={made} env={env} source={target} layout="section" onNew={() => setMaking(true)} />
      {making ? (
        <NewLinkDialog env={env} source={target} title={title} onMade={() => setMade((n) => n + 1)} onClose={() => setMaking(false)} />
      ) : null}
    </div>
  );
}

function Share({ env, target, title, size = "xs" }: { env: string; target: GuestSource; title: string; size?: "xs" | "sm" }) {
  const [open, setOpen] = useState(false);
  const [making, setMaking] = useState(false);
  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger render={<Button variant="ghost" size={size} className={size === "xs" ? "ms-auto" : undefined} />}>
          <ShareGlyph />
          Share
        </PopoverTrigger>
        <PopoverContent align="end" className="w-80 gap-0 p-1">
          <ItemLinks
            env={env}
            source={target}
            onNew={() => {
              setOpen(false);
              setMaking(true);
            }}
          />
        </PopoverContent>
      </Popover>
      {making ? <NewLinkDialog env={env} source={target} title={title} onClose={() => setMaking(false)} /> : null}
    </>
  );
}

function ItemLinks({ env, source, layout, onNew }: { env: string; source: GuestSource; layout?: "menu" | "section"; onNew(): void }) {
  const [rows, setRows] = useState<GuestLinkRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // A revoke's own refusal: kept apart from the list's read, so a reload never wipes it.
  const [refused, setRefused] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [home, setHome] = useState(env);
  const load = useCallback(() => {
    setError(null);
    guestsCall<GuestLinkRow[]>(env, "work.guests.forItem", { source }).then(
      (got) => {
        setHome(got.env);
        setRows((got.value ?? []).filter((l) => isLive(l)));
      },
      (err: unknown) => setError(errorText(err)),
    );
  }, [env, source]);
  useEffect(load, [load]);
  // The row stays, its Revoke busy, until the host confirms; refused, it stays and says why.
  const revoke = async (id: string): Promise<void> => {
    setRevoking(id);
    setRefused(null);
    try {
      await guestsCall(home, "work.guests.revoke", { linkId: id });
      setRows((now) => now?.filter((l) => l.id !== id) ?? null);
    } catch (err) {
      setRefused(errorText(err));
    } finally {
      setRevoking(null);
    }
  };
  return <LinkRows rows={rows} error={error} refused={refused} revoking={revoking} project={source.table === "projects"} layout={layout} onRevoke={(id) => void revoke(id)} onRetry={load} onNew={onNew} />;
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
          <Avatar name={l.name} size="list" />
          <span className="min-w-0 flex-1 truncate">{l.name}</span>
          {/* Revoke takes the facts' place on hover (docs/DESIGN.md "Hover reveal"). */}
          <span className="relative flex shrink-0 items-center justify-end">
            <span className={cn("text-xs text-muted-foreground tabular-nums", revoking === l.id ? "opacity-0" : yields("row"))}>
              {project ? `until ${shortDay(l.expiresAt)}` : `${ROLE_WORDS[l.role]}, ${shortDay(l.expiresAt)}`}
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
          <Button variant="ghost" size="xs" onClick={onRetry}>
            Retry
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

/** Initials on `muted` (DESIGN.md "Avatars"): 20px in a bar, `list` 24px in a list. */
export function Avatar({ name, size = "bar" }: { name: string; size?: "bar" | "list" }) {
  const words = name.trim().split(/\s+/);
  return (
    <span
      aria-hidden
      data-avatar={size}
      className={cn(
        "grid shrink-0 place-items-center rounded-full bg-muted text-[9px] font-semibold text-muted-foreground outline-1 -outline-offset-1 outline-(--image-outline)",
        size === "list" ? "size-6" : "size-5",
      )}
    >
      {((words[0]?.[0] ?? "") + (words[1]?.[0] ?? "")).toUpperCase()}
    </span>
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

function NewLinkDialog({ env, source, title, onMade, onClose }: { env: string; source: GuestSource; title: string; onMade?(): void; onClose(): void }) {
  const [name, setName] = useState("");
  const [role, setRole] = useState<GuestRole>("view");
  const [days, setDays] = useState<string>("30");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [made, setMade] = useState<GuestCreated | null>(null);
  const { root, closeThen } = useClosingDialog(onClose, pending);
  // A sheet's guest can view or edit: sheets keep no comments. A project's guest views, so there is nothing to pick.
  const roles: GuestRole[] = source.table === "projects" ? ["view"] : source.table === "sheets" ? ["view", "edit"] : ["view", "comment", "edit"];
  const at = (d: number): number => Date.now() + d * 24 * 60 * 60_000;

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (!name.trim() || pending) return;
    setPending(true);
    setError(null);
    try {
      const got = await guestsCall<GuestCreated>(env, "work.guests.create", { source, title, name: name.trim(), role, expiresAt: at(Number(days)) });
      setMade(got.value);
      onMade?.();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog {...root}>
      <ModalPanel onClose={() => closeThen(onClose)} busy={pending} title={made ? `Link for ${made.link.name}` : "New guest link"} description={title} size="sm">
        {made ? (
          <>
            <MadeAddress url={made.url} link={made.link} />
            <DialogFooter confirmLabel="Done" onConfirm={() => closeThen(onClose)} />
          </>
        ) : (
          <form onSubmit={(event) => void submit(event)}>
            <div className="flex flex-col gap-4 px-5 py-4">
              <Field label="For">
                <Input autoFocus value={name} maxLength={80} onChange={(event) => setName(event.target.value)} placeholder="Name" autoComplete="off" />
              </Field>
              <div className="flex flex-col">
                {roles.length > 1 ? (
                  <FieldRow label="Can">
                    <ToggleGroup
                      size="xs"
                      value={[role]}
                      onValueChange={(value) => {
                        if (value[0]) setRole(value[0] as GuestRole);
                      }}
                    >
                      {roles.map((r) => (
                        <ToggleGroupItem key={r} value={r}>
                          {ROLE_WORDS[r]}
                        </ToggleGroupItem>
                      ))}
                    </ToggleGroup>
                  </FieldRow>
                ) : null}
                <FieldRow label="Ends">
                  <ChoiceSelect size="sm" label="Ends" value={days} options={ENDS.map((d) => ({ value: String(d), label: dayOf(at(d)) }))} onChange={setDays} />
                </FieldRow>
              </div>
              <ErrorLine error={error} />
            </div>
            <DialogFooter onCancel={() => closeThen(onClose)} confirmLabel="Create link" pending={pending} disabled={!name.trim()} />
          </form>
        )}
      </ModalPanel>
    </Dialog>
  );
}
