import { useCallback, useEffect, useState, type FormEvent } from "react";
import { DialogFooter, ErrorLine } from "../../chrome/ConfirmDialog";
import { Field, FieldRow } from "../../chrome/DialogField";
import { MoreHorizontal } from "../../chrome/icons";
import { ModalPanel, useClosingDialog } from "../../chrome/Modal";
import { Region, useInBones } from "../../components/bones";
import { ChoiceSelect } from "../../components/choice-select";
import { BusyLabel, Button } from "../../components/ui/button";
import { Dialog } from "../../components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger } from "../../components/ui/dropdown-menu";
import { Input } from "../../components/ui/input";
import { ToggleGroup, ToggleGroupItem } from "../../components/ui/toggle-group";
import { hostFailure } from "../../lib/hostFailure";
import { registry } from "../../lib/connection";
import { Face } from "../mail/face";
import { confirmReplace, confirmRevoke, MadeAddress } from "./Share";
import { dayOf, ENDS, guestRolesOf, guestsCall, isLive, isShareRefusal, linkFacts, ROLE_WORDS, SHARE_REFUSALS, type GuestCreated, type GuestLinkRow, type GuestRole, type GuestSource } from "./api";

/** What a Share sheet is for: a source a link can take, or the one line that says what to do instead. */
export type ShareTarget = { source: GuestSource } | { why: string };

/**
 * Share (docs/DESIGN.md "Share"): one sheet for a document, a sheet or a project, from its header, File → Share…, a
 * Files row's menu and More. On top, a new link: who it is for, what they can do, the day it ends; Create link shows the
 * address once, with Copy. Under it, the item's live links, each with what they can do, when it was made, last opened
 * and ends, and its menu: Replace address…, the role, Revoke. Where no link can be made, one line says what to do
 * instead, in the form's place. A Purdue workspace's file is university data: one line says so over Create link.
 * Making or widening a link is his press here; a thread only asks (`guest_link`, held in the Outbox).
 */
export default function ShareSheet({ env, target, title, purdue = false, onClose }: { env: string; target: ShareTarget; title: string; purdue?: boolean; onClose(): void }) {
  const source = "source" in target ? target.source : null;
  // The host's own refusal of this file, read with its links: said as the sheet's line, not as a failure.
  const [refused, setRefused] = useState<string | null>("why" in target ? target.why : null);
  const [made, setMade] = useState<{ url: string; link: GuestLinkRow } | null>(null);
  const [pending, setPending] = useState(false);
  const { root, closeThen } = useClosingDialog(onClose, pending);
  const close = (): void => closeThen(onClose);
  return (
    <Dialog {...root}>
      <ModalPanel data-share-sheet="" onClose={close} busy={pending} title="Share" description={title}>
        {refused ? (
          <>
            <p data-share-why="" className="px-5 py-4 text-[13px] text-muted-foreground">
              {refused}
            </p>
            <DialogFooter confirmLabel="Done" onConfirm={close} />
          </>
        ) : source ? (
          <Sharing env={env} source={source} title={title} purdue={purdue} made={made} onMade={setMade} pending={pending} onPending={setPending} onRefused={setRefused} onClose={close} />
        ) : null}
      </ModalPanel>
    </Dialog>
  );
}

function Sharing({
  env,
  source,
  title,
  purdue,
  made,
  onMade,
  pending,
  onPending,
  onRefused,
  onClose,
}: {
  env: string;
  source: GuestSource;
  title: string;
  purdue: boolean;
  made: { url: string; link: GuestLinkRow } | null;
  onMade(made: { url: string; link: GuestLinkRow } | null): void;
  pending: boolean;
  onPending(pending: boolean): void;
  onRefused(why: string): void;
  onClose(): void;
}) {
  const roles = guestRolesOf(source);
  const [name, setName] = useState("");
  const [role, setRole] = useState<GuestRole>("view");
  const [days, setDays] = useState<string>("30");
  const [error, setError] = useState<string | null>(null);
  const [rows, setRows] = useState<GuestLinkRow[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [home, setHome] = useState(env);
  const at = (d: number): number => Date.now() + d * 24 * 60 * 60_000;

  const load = useCallback((): Promise<void> => {
    return guestsCall<GuestLinkRow[]>(env, "work.guests.forItem", { source }).then(
      (got) => {
        setListError(null);
        setHome(got.env);
        setRows((got.value ?? []).filter((l) => isLive(l)));
      },
      (err: unknown) => {
        const line = refusalIn(err instanceof Error ? err.message : String(err));
        if (line) return onRefused(line);
        setListError(hostFailure(env, err, "could not list the guest links"));
      },
    );
  }, [env, source, onRefused]);
  useEffect(() => void load(), [load]);
  // A link made, changed or revoked anywhere (a held request he created in the Outbox): the host says so.
  useEffect(() => registry.linkOf(home).onPush((push) => push.push === "work.guests" && void load()), [home, load]);

  const submit = async (event?: FormEvent): Promise<void> => {
    event?.preventDefault();
    // The sheet may be mounted inside another form (a project's settings): a submit is this sheet's alone.
    event?.stopPropagation();
    if (!name.trim() || pending) return;
    onPending(true);
    setError(null);
    try {
      const got = await guestsCall<GuestCreated>(env, "work.guests.create", { source, title, name: name.trim(), role, expiresAt: at(Number(days)) });
      onMade({ url: got.value.url, link: got.value.link });
      setName("");
      void load();
    } catch (err) {
      setError(hostFailure(env, err, "did not make the link", true));
    } finally {
      onPending(false);
    }
  };

  // Until the host answers for this item the form is its bones: a form it would then refuse is never shown live.
  const loading = rows === null && !listError && !made;
  return (
    <>
      <Region loading={loading} label="Loading" bones={() => <ShareForm roles={roles} name="" role="view" days="30" error={null} bones />}>
        {made ? (
          <MadeAddress url={made.url} link={made.link} />
        ) : (
          <ShareForm roles={roles} name={name} onName={setName} role={role} onRole={setRole} days={days} onDays={setDays} error={error} onSubmit={(event) => void submit(event)} />
        )}
        <LiveLinks env={home} rows={rows} error={listError} onRetry={() => load()} onChanged={() => void load()} onAddress={onMade} onRevoked={(id) => made?.link.id === id && onMade(null)} />
      </Region>
      {made ? (
        <DialogFooter start={<Button variant="ghost" size="sm" onClick={() => onMade(null)}>New link</Button>} confirmLabel="Done" onConfirm={onClose} />
      ) : (
        // A Purdue workspace's file is university data: said once, beside the press that shares it.
        <DialogFooter note={purdue ? PURDUE_LINE : undefined} onCancel={onClose} confirmLabel="Create link" pending={pending} disabled={loading || !name.trim()} onConfirm={() => void submit()} />
      )}
    </>
  );
}

const NO_CHANGE = (): void => undefined;

/** A new link's form: who it is for, what they can do, the day it ends. At rest, with no handlers, it is the sheet's bones. */
function ShareForm({
  roles,
  name,
  onName = NO_CHANGE,
  role,
  onRole = NO_CHANGE,
  days,
  onDays = NO_CHANGE,
  error,
  onSubmit,
  bones = false,
}: {
  roles: readonly GuestRole[];
  name: string;
  onName?(name: string): void;
  role: GuestRole;
  onRole?(role: GuestRole): void;
  days: string;
  onDays?(days: string): void;
  error: string | null;
  onSubmit?(event: FormEvent): void;
  bones?: boolean;
}) {
  const inBones = useInBones();
  const at = (d: number): number => Date.now() + d * 24 * 60 * 60_000;
  return (
    <form data-share-bones={bones ? "" : undefined} onSubmit={onSubmit ?? ((event) => event.preventDefault())} className="flex flex-col gap-4 px-5 py-4">
      <Field label="For">
        <Input autoFocus={!inBones} value={name} maxLength={80} onChange={(event) => onName(event.target.value)} placeholder="Name" autoComplete="off" />
      </Field>
      <div className="flex flex-col">
        {roles.length > 1 ? (
          <FieldRow label="Can">
            <ToggleGroup
              size="xs"
              value={[role]}
              onValueChange={(value) => {
                if (value[0]) onRole(value[0] as GuestRole);
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
          <ChoiceSelect size="sm" label="Ends" value={days} options={ENDS.map((d) => ({ value: String(d), label: dayOf(at(d)) }))} onChange={onDays} />
        </FieldRow>
      </div>
      <ErrorLine error={error} />
    </form>
  );
}

/** The item's live links under the form: a hairline, then one row each; nothing at all while there are none or none are read yet. */
function LiveLinks({
  env,
  rows,
  error,
  onRetry,
  onChanged,
  onAddress,
  onRevoked,
}: {
  env: string;
  rows: GuestLinkRow[] | null;
  error: string | null;
  onRetry(): Promise<void>;
  onChanged(): void;
  onAddress(made: { url: string; link: GuestLinkRow }): void;
  /** A link revoked: its address shown above the list goes with it, so it cannot be copied after. */
  onRevoked(linkId: string): void;
}) {
  const [retrying, setRetrying] = useState(false);
  if ((rows === null || rows.length === 0) && !error) return null;
  return (
    <div data-share-links="" className="flex flex-col border-t border-border px-3 py-2">
      {rows?.map((l) => <LinkRow key={l.id} env={env} link={l} onChanged={onChanged} onAddress={onAddress} onRevoked={onRevoked} />)}
      {error ? (
        <div className="flex min-h-11 items-center gap-2 px-2">
          <div className="min-w-0 flex-1">
            <ErrorLine error={error} />
          </div>
          <Button
            variant="ghost"
            size="xs"
            disabled={retrying}
            onClick={() => {
              setRetrying(true);
              void onRetry().finally(() => setRetrying(false));
            }}
          >
            <BusyLabel busy={retrying} label="Retry" />
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function LinkRow({ env, link, onChanged, onAddress, onRevoked }: { env: string; link: GuestLinkRow; onChanged(): void; onAddress(made: { url: string; link: GuestLinkRow }): void; onRevoked(linkId: string): void }) {
  const roles = guestRolesOf(link.source.at === "file" ? link.source : { at: "lifeos", table: link.source.table });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const act = async (run: () => Promise<void>, failed: string): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await run();
      onChanged();
    } catch (err) {
      setError(hostFailure(env, err, failed, true));
    } finally {
      setBusy(false);
    }
  };
  // The address is kept only as a hash: a new one is made, and the one before stops opening, so he is asked first.
  const replace = async (): Promise<void> => {
    if (!(await confirmReplace(link.name))) return;
    await act(async () => {
      const { url } = await registry.linkOf(env).request<{ url: string }>("work.guests.rekey", { linkId: link.id });
      onAddress({ url, link });
    }, "did not replace the address");
  };
  // Asked first, with no Undo after: a revoked address must never open again (decision 21).
  const revoke = async (): Promise<void> => {
    if (!(await confirmRevoke(link.name))) return;
    await act(() => registry.linkOf(env).request("work.guests.revoke", { linkId: link.id }).then(() => onRevoked(link.id)), "did not revoke the link");
  };
  return (
    <div data-share-link={link.id} className="flex min-h-11 min-w-0 items-center gap-2.5 rounded-lg px-2 py-1.5">
      <Face name={link.name} size="row" />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-[13px] text-foreground">{link.name}</span>
        {/* Its facts wrap in a narrow sheet, so the date it ends is never cut away; the menu stays on the row's centre. */}
        {error ? <ErrorLine error={error} /> : <span data-share-link-facts className="text-xs text-pretty text-muted-foreground tabular-nums">{linkFacts(link)}</span>}
      </div>
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label={`${link.name}'s link`} disabled={busy} />}>{busy ? <BusyLabel busy label="" /> : <MoreHorizontal />}</DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-44">
          <DropdownMenuItem onClick={() => void replace()}>Replace address…</DropdownMenuItem>
          {roles.length > 1 ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuRadioGroup
                value={link.role}
                onValueChange={(next) => {
                  if (next !== link.role) void act(() => registry.linkOf(env).request("work.guests.setRole", { linkId: link.id, role: next }).then(() => undefined), "did not change what they can do");
                }}
              >
                {roles.map((r) => (
                  <DropdownMenuRadioItem key={r} value={r}>
                    Can {ROLE_WORDS[r].toLowerCase()}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </>
          ) : null}
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onClick={() => void revoke()}>
            Revoke…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

/** The line a Purdue workspace's Share sheet holds beside Create link (Purdue's rules on its data; the owner's call). */
export const PURDUE_LINE = "Purdue's data: this shares it outside Purdue.";

/** The refusal line a host's answer holds, whatever the window put before it. */
const refusalIn = (text: string): string | null => (isShareRefusal(text) ? (Object.values(SHARE_REFUSALS) as string[]).find((line) => text.includes(line))! : null);
