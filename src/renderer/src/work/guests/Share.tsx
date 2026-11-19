import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { CanvasSource } from "@shared/work";
import { Check, Copy } from "../../chrome/icons";
import { SwapIcon } from "../../motion/IconSwap";
import { ModalPanel, useClosingDialog } from "../../chrome/Modal";
import { Field, FieldRow } from "../../chrome/DialogField";
import { DialogFooter, ErrorLine, errorText } from "../../chrome/ConfirmDialog";
import { ChoiceSelect } from "../../components/choice-select";
import { Button } from "../../components/ui/button";
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
 * Only a LifeOS document or sheet can be shared; any other source draws no Share.
 */
export function ShareButton({ env, source, title }: { env: string; source: CanvasSource; title: string }) {
  const target = guestSource(source);
  return target ? <Share env={env} target={target} title={title} /> : null;
}

function Share({ env, target, title }: { env: string; target: GuestSource; title: string }) {
  const [open, setOpen] = useState(false);
  const [making, setMaking] = useState(false);
  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger render={<Button variant="ghost" size="xs" className="ms-auto" />}>Share</PopoverTrigger>
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

function ItemLinks({ env, source, onNew }: { env: string; source: GuestSource; onNew(): void }) {
  const [rows, setRows] = useState<GuestLinkRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [home, setHome] = useState(env);
  const load = useCallback(() => {
    setError(null);
    guestsCall<GuestLinkRow[]>(env, "work.guests.forItem", { source }).then(
      (got) => {
        setHome(got.env);
        setRows(got.value.filter((l) => isLive(l)));
      },
      (err: unknown) => setError(errorText(err)),
    );
  }, [env, source]);
  useEffect(load, [load]);
  const revoke = async (id: string): Promise<void> => {
    setRows((now) => now?.filter((l) => l.id !== id) ?? null);
    try {
      await guestsCall(home, "work.guests.revoke", { linkId: id });
    } catch (err) {
      setError(errorText(err));
      load();
    }
  };
  return (
    <div className="flex flex-col">
      {rows === null && !error ? (
        <div className="flex h-9 items-center px-2">
          <Skeleton className="h-3 w-40" />
        </div>
      ) : null}
      {rows?.length === 0 ? <p className="flex h-9 items-center px-2 text-[13px] text-muted-foreground">Only you can open this</p> : null}
      {rows?.map((l) => (
        <div key={l.id} className="group/row flex h-9 min-w-0 items-center gap-2 rounded-lg px-2 text-[13px] hover:bg-foreground/5">
          <Avatar name={l.name} />
          <span className="min-w-0 flex-1 truncate">{l.name}</span>
          {/* Revoke takes the facts' place on hover (docs/DESIGN.md "Hover reveal"). */}
          <span className="relative flex shrink-0 items-center justify-end">
            <span className={cn("text-xs text-muted-foreground tabular-nums", yields("row"))}>
              {ROLE_WORDS[l.role]}, {shortDay(l.expiresAt)}
            </span>
            <span className={cn("absolute end-0", reveal("row", { row: true, overlay: true }))}>
              <Button variant="ghost" size="xs" aria-label={`Revoke ${l.name}'s link`} onClick={() => void revoke(l.id)}>
                Revoke
              </Button>
            </span>
          </span>
        </div>
      ))}
      {error ? (
        <div className="flex min-h-9 items-center gap-2 px-2">
          <div className="min-w-0 flex-1">
            <ErrorLine error={error} />
          </div>
          <Button variant="ghost" size="xs" onClick={load}>
            Retry
          </Button>
        </div>
      ) : null}
      <div className="mt-1 border-t border-border pt-1">
        <Button variant="ghost" size="sm" className="w-full justify-start" onClick={onNew}>
          New guest link…
        </Button>
      </div>
    </div>
  );
}

export function Avatar({ name }: { name: string }) {
  const words = name.trim().split(/\s+/);
  return (
    <span aria-hidden className="grid size-5 shrink-0 place-items-center rounded-full bg-muted text-[9px] font-semibold text-muted-foreground outline-1 -outline-offset-1 outline-(--image-outline)">
      {((words[0]?.[0] ?? "") + (words[1]?.[0] ?? "")).toUpperCase()}
    </span>
  );
}

function NewLinkDialog({ env, source, title, onClose }: { env: string; source: GuestSource; title: string; onClose(): void }) {
  const [name, setName] = useState("");
  const [role, setRole] = useState<GuestRole>("view");
  const [days, setDays] = useState<string>("30");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [made, setMade] = useState<GuestCreated | null>(null);
  const [copied, setCopied] = useState(false);
  const { root, closeThen } = useClosingDialog(onClose, pending);
  // A sheet's guest can view or edit: sheets keep no comments.
  const roles: GuestRole[] = source.table === "sheets" ? ["view", "edit"] : ["view", "comment", "edit"];
  const at = (d: number): number => Date.now() + d * 24 * 60 * 60_000;

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (!name.trim() || pending) return;
    setPending(true);
    setError(null);
    try {
      const got = await guestsCall<GuestCreated>(env, "work.guests.create", { source, title, name: name.trim(), role, expiresAt: at(Number(days)) });
      setMade(got.value);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setPending(false);
    }
  };
  const copy = async (): Promise<void> => {
    if (!made) return;
    await copyText(made.url);
    setCopied(true);
  };

  return (
    <Dialog {...root}>
      <ModalPanel onClose={() => closeThen(onClose)} busy={pending} title={made ? `Link for ${made.link.name}` : "New guest link"} description={title} size="sm">
        {made ? (
          <>
            <div className="flex flex-col gap-2 px-5 py-4">
              <div className="flex h-9 min-w-0 items-center gap-2 rounded-lg border border-input ps-3 pe-1">
                <span className="min-w-0 flex-1 truncate font-mono text-xs select-all">{made.url}</span>
                <Button variant="ghost" size="xs" onClick={() => void copy()}>
                  <SwapIcon swapped={copied} from={<Copy />} to={<Check />} />
                  {copied ? "Copied" : "Copy"}
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                {made.link.name} can {ROLE_WORDS[made.link.role].toLowerCase()} until {dayOf(made.link.expiresAt)}. This address is shown only now.
              </p>
            </div>
            <DialogFooter confirmLabel="Done" onConfirm={() => closeThen(onClose)} />
          </>
        ) : (
          <form onSubmit={(event) => void submit(event)}>
            <div className="flex flex-col gap-4 px-5 py-4">
              <Field label="For">
                <Input autoFocus value={name} maxLength={80} onChange={(event) => setName(event.target.value)} placeholder="Name" autoComplete="off" />
              </Field>
              <div className="flex flex-col">
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
