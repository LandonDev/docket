import { useRef, useState } from "react";
import { ConvexProvider } from "convex/react";
import { accountLine, MailClientProvider, MailEditor, MailKitProvider, signatureLine, useMailClient, type MailClient, type MailEditorProps } from "work-kit/mail";
import type { MailAccount, MailNotify, MailSignature, SignatureDefault } from "work-kit/mail";
import { identitiesOf, isPurdue, type ComposeAccount } from "work-kit/mail/lib/compose";
import { fromMailHtml, toMailHtml } from "work-kit/mail/lib/mail-html";
import { SECTOR_KEYS, type SectorKey } from "work-kit/lifeos/types";
import "work-kit/mail/styles.css";
import "./mail.css";
import { confirmAction } from "../../chrome/ConfirmDialog";
import { DialogFooter, ErrorLine } from "../../chrome/ConfirmDialog";
import { Field, FieldRow } from "../../chrome/DialogField";
import { Modal, ModalBody, useModalClose } from "../../chrome/Modal";
import { ChoiceSelect } from "../../components/choice-select";
import { PageEmpty, PageRow, PageRowsSkeleton, PageSection } from "../../components/page";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { registry, useEnvironments } from "../../lib/connection";
import { workErrorWords } from "../../lib/workErrorWords";
import { useWorkHosts, workHome } from "../../lib/workSwitch";
import { SettingRow, SettingSection } from "../../surfaces/settings/parts/SettingRow";
import { useSaved } from "../../surfaces/settings/parts/useSaved";
import { settingTitle } from "../../lib/settings/map";
import { LifeosLine } from "../connections/LifeosLine";
import { useJobName } from "../jobName";
import { useLifeosSession } from "../shell/lifeos";
import { GrantsRow } from "../shell/WorkPageSends";
import { mailClientFor } from "./client";
import { tempcodeMailKit } from "./kit";

/**
 * Settings → Mail (docs/agents/work-mail.md "Settings", docs/agents/settings.md "The pages: Work"): mail's settings
 * drawn through the page's own parts over work-kit's mail client, so the page reads as every other: Writing, Reading,
 * Signatures and Accounts, then the one open row to the send grants Work shows too. LifeOS keeps every value, on the
 * computer's whole LifeOS session (mail belongs to no one job), so LifeOS desktop and the phone read the same. A row
 * moves at once and goes back if LifeOS refuses; a signature and an account open in a dialog; Delete… asks first.
 * work-kit's own settings screen stays LifeOS's.
 */

/** Settings → Mail: the settings of the computer new jobs are made on (its LifeOS session is LifeOS's, the same everywhere). */
export function MailPage() {
  const linked = useEnvironments();
  useWorkHosts();
  const home = workHome(linked, registry.primaryEnvironmentId);
  return (
    <>
      {home ? <Section environmentId={home} /> : null}
      <SettingSection of="mail.grants">
        <GrantsRow id="mail.grants" />
      </SettingSection>
    </>
  );
}

/** One computer's LifeOS session, or its state in the page's first section's place. */
export function Section({ environmentId }: { environmentId: string }) {
  const lifeos = useLifeosSession(environmentId, null);
  if (!lifeos.client)
    return (
      <PageSection data-mail-down="">
        <LifeosLine session={lifeos} onWorkPage waiting={<PageRowsSkeleton rows={3} control="select" />} />
      </PageSection>
    );
  return (
    <ConvexProvider client={lifeos.client}>
      <MailClientProvider client={mailClientFor(environmentId, lifeos.client.url, "all")}>
        <MailSettingsBody />
      </MailClientProvider>
    </ConvexProvider>
  );
}

type Editor = NonNullable<Parameters<NonNullable<MailEditorProps["onReady"]>>[0]>;
type MailEditorTools = NonNullable<Parameters<NonNullable<MailEditorProps["onReady"]>>[1]>;
/** Mail's own settings (work-kit's `MailSettings` type, whose name its index gives the screen). */
type MailSettings = NonNullable<ReturnType<MailClient["useMailSettings"]>>;

const NONE = "none";
/** In an account's dialog: the address still takes its provider's signature. */
const OWN = "own";

const UNDO: { value: string; label: string }[] = [5, 10, 20, 30].map((n) => ({ value: String(n), label: `${n} seconds` }));
const REPLIES = [
  { value: "sender", label: "The sender" },
  { value: "everyone", label: "Everyone" },
];
const PICTURES = [
  { value: "show", label: "Show" },
  { value: "ask", label: "Ask" },
  { value: "never", label: "Never" },
];
const DENSITY = [
  { value: "three", label: "Three lines" },
  { value: "two", label: "Two lines" },
];
const MARK_READ = [
  { value: "second", label: "After a second" },
  { value: "open", label: "On open" },
  { value: "never", label: "Never" },
];
const NOTIFY: { value: MailNotify; label: string }[] = [
  { value: "never", label: "Never" },
  { value: "needsMe", label: "When mail needs me" },
  { value: "all", label: "All new mail" },
];

/** A LifeOS refusal in the house's words. */
const lifeosWords = (err: unknown, fallback: string): string => workErrorWords(err, { write: true }) || fallback;

/**
 * Whether an address still takes the signature its provider keeps for it: it has one there, and nobody has chosen
 * for it here (work-kit's own rule, mail/settings.tsx, which its index does not export).
 */
export function takesOwnSignature(account: Pick<MailAccount, "signatureDefaults">, sends: ComposeAccount | undefined, address: string): boolean {
  const at = address.toLowerCase();
  if (!sends || account.signatureDefaults?.some((d) => d.address.toLowerCase() === at)) return false;
  return identitiesOf(sends).some((i) => i.address.toLowerCase() === at && Boolean(i.signatureHtml));
}

/** The settings under whatever mail client is round them (the mail preview's fixture client draws them in a page). */
export function MailSettingsBody() {
  const client = useMailClient();
  const settings = client.useMailSettings();
  const accounts = client.useMailAccounts();
  const compose = client.useComposeAccounts();
  const signatures = client.useSignatures();
  const senders = client.useImageSenders();
  const actions = client.useSettingsActions();
  const [signature, setSignature] = useState<MailSignature | "new" | null>(null);
  const [account, setAccount] = useState<string | null>(null);
  if (!settings || !accounts || !signatures)
    return (
      <>
        <SettingSection of="mail.from">
          <PageRowsSkeleton rows={3} control="select" />
        </SettingSection>
        <SettingSection of="mail.pictures">
          <PageRowsSkeleton rows={3} control="select" />
        </SettingSection>
        <SettingSection of="mail.signatures">
          <PageRowsSkeleton rows={2} description />
        </SettingSection>
      </>
    );
  const set = (patch: Partial<MailSettings>) => () =>
    actions.update(patch).catch((err: unknown) => {
      throw new Error(lifeosWords(err, "LifeOS did not save that."));
    });
  const opened = accounts.find((a) => a.id === account);
  return (
    <MailKitProvider kit={tempcodeMailKit}>
      <SettingSection of="mail.from">
        <Choice
          id="mail.from"
          value={settings.defaultAccountId && accounts.some((a) => a.id === settings.defaultAccountId) ? settings.defaultAccountId : NONE}
          options={[{ value: NONE, label: "The last one used" }, ...accounts.map((a) => ({ value: a.id, label: a.address }))]}
          save={(next) => set({ defaultAccountId: next === NONE ? undefined : next })}
        />
        <Choice id="mail.replies" value={settings.replyDefault} options={REPLIES} save={(next) => set({ replyDefault: next as MailSettings["replyDefault"] })} />
        <Choice id="mail.undo" value={String(settings.undoSeconds)} options={UNDO} save={(next) => set({ undoSeconds: Number(next) as MailSettings["undoSeconds"] })} />
      </SettingSection>
      <SettingSection of="mail.pictures">
        <Choice id="mail.pictures" value={settings.pictures} options={PICTURES} save={(next) => set({ pictures: next as MailSettings["pictures"] })} />
        {settings.pictures === "ask" && senders?.length ? <SendersRow senders={senders} remove={(address) => actions.disallowImages(address)} /> : null}
        <Choice id="mail.density" value={settings.density} options={DENSITY} save={(next) => set({ density: next as MailSettings["density"] })} />
        <Choice id="mail.markRead" value={settings.markRead} options={MARK_READ} save={(next) => set({ markRead: next as MailSettings["markRead"] })} />
      </SettingSection>
      <SettingSection
        of="mail.signatures"
        action={
          <Button variant="ghost" size="sm" onClick={() => setSignature("new")}>
            New signature…
          </Button>
        }
      >
        {signatures.length ? (
          signatures.map((s) => <PageRow key={s.id} data-signature={s.id} title={s.name} description={signatureLine(s.html) || "Empty"} onOpen={() => setSignature(s)} openLabel={`Signature ${s.name}`} />)
        ) : (
          <PageEmpty>No signatures yet</PageEmpty>
        )}
      </SettingSection>
      <SettingSection of="mail.accounts">
        {accounts.length ? (
          accounts.map((a) => (
            <PageRow
              key={a.id}
              data-account={a.id}
              title={a.address}
              description={accountLine(a, signatures, takesOwnSignature(a, compose?.find((c) => c.id === a.id), a.address))}
              onOpen={() => setAccount(a.id)}
              openLabel={a.address}
            />
          ))
        ) : (
          <PageEmpty>No mail account. Connect one in LifeOS.</PageEmpty>
        )}
      </SettingSection>
      {signature ? (
        <SignatureDialog
          signature={signature === "new" ? null : signature}
          onClose={() => setSignature(null)}
          onSave={(next) => actions.saveSignature(next)}
          onDelete={(id) => actions.removeSignature(id)}
        />
      ) : null}
      {opened ? (
        <AccountDialog account={opened} sends={compose?.find((c) => c.id === opened.id)} signatures={signatures} onClose={() => setAccount(null)} onSave={(patch) => actions.updateAccount(opened.id, patch)} />
      ) : null}
    </MailKitProvider>
  );
}

/** One setting's select: it moves at once, marks its save, and goes back with LifeOS's reason when refused. */
function Choice({ id, value, options, save }: { id: string; value: string; options: { value: string; label: string }[]; save: (next: string) => () => Promise<unknown> }) {
  const saved = useSaved();
  const [shown, setShown] = useState<string | null>(null);
  return (
    <SettingRow id={id} saved={saved}>
      <ChoiceSelect
        size="sm"
        label={settingTitle(id)}
        value={shown ?? value}
        options={options}
        onChange={(next) => {
          setShown(next);
          void saved.run(save(next)).finally(() => setShown(null));
        }}
      />
    </SettingRow>
  );
}

/** The senders whose web pictures always show: a row that opens them, each to remove at one press. */
function SendersRow({ senders, remove }: { senders: string[]; remove: (address: string) => Promise<unknown> }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <SettingRow id="mail.senders" description={senders.length === 1 ? "1 sender" : `${senders.length} senders`} onOpen={() => setOpen(true)} openLabel="Pictures always show from" />
      {open ? <SendersDialog senders={senders} remove={remove} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function SendersDialog({ senders, remove, onClose }: { senders: string[]; remove: (address: string) => Promise<unknown>; onClose: () => void }) {
  const [error, setError] = useState<string | null>(null);
  return (
    <Modal onClose={onClose} title="Pictures always show from" size="sm">
      <ModalBody className="gap-0">
        {senders.map((address) => (
          <div key={address} data-sender={address} className="flex min-h-10 items-center gap-3 border-t border-border first:border-t-0">
            <span className="min-w-0 flex-1 truncate text-[13px]">{address}</span>
            <Button variant="ghost" size="sm" className="-me-2.5" onClick={() => void remove(address).catch((err: unknown) => setError(lifeosWords(err, "LifeOS did not remove that sender.")))}>
              Remove
            </Button>
          </div>
        ))}
        <ErrorLine error={error} />
      </ModalBody>
    </Modal>
  );
}

/** A signature's name and its words, with pictures and links; Delete… asks first. */
function SignatureDialog({
  signature,
  onClose,
  onSave,
  onDelete,
}: {
  signature: MailSignature | null;
  onClose: () => void;
  onSave: (next: { id?: string | undefined; name: string; html: string }) => Promise<unknown>;
  onDelete: (id: string) => Promise<unknown>;
}) {
  const [pending, setPending] = useState(false);
  return (
    <Modal onClose={onClose} title={signature ? signature.name : "New signature"} size="sm" busy={pending}>
      <SignatureForm signature={signature} onClose={onClose} onSave={onSave} onDelete={onDelete} pending={pending} setPending={setPending} />
    </Modal>
  );
}

function SignatureForm({
  signature,
  onClose,
  onSave,
  onDelete,
  pending,
  setPending,
}: {
  signature: MailSignature | null;
  onClose: () => void;
  onSave: (next: { id?: string | undefined; name: string; html: string }) => Promise<unknown>;
  onDelete: (id: string) => Promise<unknown>;
  pending: boolean;
  setPending: (pending: boolean) => void;
}) {
  const close = useModalClose();
  const upload = useMailClient().useOutboxActions().upload;
  const [name, setName] = useState(signature?.name ?? "");
  const [live, setLive] = useState<Editor | null>(null);
  const [uploads, setUploads] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const tools = useRef<MailEditorTools | undefined>(undefined);
  const picture = useRef<HTMLInputElement>(null);
  const [start] = useState(() => fromMailHtml(signature?.html ?? ""));
  const done = (): void => (close ? close(onClose) : onClose());
  const run = async (write: () => Promise<unknown>, fallback: string): Promise<void> => {
    setPending(true);
    setError(null);
    try {
      await write();
      done();
    } catch (err) {
      setError(lifeosWords(err, fallback));
    }
    setPending(false);
  };
  const remove = async (): Promise<void> => {
    if (!signature) return;
    const sure = await confirmAction({
      title: `Delete the signature “${signature.name}”?`,
      body: "Mail that would take it goes out with no signature until you choose another.",
      action: "Delete",
      danger: true,
    });
    if (sure) await run(() => onDelete(signature.id), "LifeOS did not delete the signature.");
  };
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (live && name.trim() && uploads === 0) void run(() => onSave({ id: signature?.id, name: name.trim(), html: toMailHtml(live.getJSON()).html }), "LifeOS did not save the signature.");
      }}
    >
      <ModalBody>
        <Field label="Name">
          <Input value={name} autoFocus={!signature} maxLength={80} disabled={pending} onChange={(event) => setName(event.target.value)} />
        </Field>
        <Field label="Signature">
          <div data-mail-kit className="tc-mail max-h-64 min-h-30 overflow-x-hidden overflow-y-auto rounded-lg border border-input px-3 py-2.5">
            <MailEditor
              content={start}
              placeholder="Your name, and what goes under it"
              autoFocus={Boolean(signature)}
              upload={upload}
              onUploads={setUploads}
              onUploadError={(message) => setError(message)}
              onReady={(editor, api) => {
                tools.current = api;
                setLive(editor);
              }}
            />
          </div>
        </Field>
        <div className="-mt-2 flex gap-1">
          <Button type="button" variant="ghost" size="sm" className="-ms-2.5" disabled={!live || pending} onClick={() => tools.current?.link()}>
            Link…
          </Button>
          <Button type="button" variant="ghost" size="sm" disabled={!live || pending} onClick={() => picture.current?.click()}>
            Picture…
          </Button>
          <input
            ref={picture}
            type="file"
            accept="image/*"
            hidden
            onChange={(event) => {
              tools.current?.insertFiles([...(event.target.files ?? [])]);
              event.target.value = "";
            }}
          />
        </div>
        <ErrorLine error={error} />
      </ModalBody>
      <DialogFooter
        start={
          signature ? (
            <Button type="button" variant="ghost" className="text-muted-foreground hover:text-destructive" disabled={pending} onClick={() => void remove()}>
              Delete…
            </Button>
          ) : undefined
        }
        onCancel={done}
        confirmLabel="Save"
        pending={pending}
        disabled={!live || !name.trim() || uploads > 0}
      />
    </form>
  );
}

type AccountPatch = { label?: string; defaultSector?: SectorKey | null; signatureDefaults?: SignatureDefault[]; notify?: MailNotify };

/** An account's name, its job, the signature each of its addresses takes, and when LifeOS tells of its mail. */
function AccountDialog({
  account,
  sends,
  signatures,
  onClose,
  onSave,
}: {
  account: MailAccount;
  sends: ComposeAccount | undefined;
  signatures: MailSignature[];
  onClose: () => void;
  onSave: (patch: AccountPatch) => Promise<unknown>;
}) {
  const [pending, setPending] = useState(false);
  return (
    <Modal onClose={onClose} title={account.address} size="sm" busy={pending}>
      <AccountForm account={account} sends={sends} signatures={signatures} onClose={onClose} onSave={onSave} pending={pending} setPending={setPending} />
    </Modal>
  );
}

function AccountForm({
  account,
  sends,
  signatures,
  onClose,
  onSave,
  pending,
  setPending,
}: {
  account: MailAccount;
  sends: ComposeAccount | undefined;
  signatures: MailSignature[];
  onClose: () => void;
  onSave: (patch: AccountPatch) => Promise<unknown>;
  pending: boolean;
  setPending: (pending: boolean) => void;
}) {
  const close = useModalClose();
  const jobName = useJobName();
  const addresses = sends ? identitiesOf(sends).map((i) => i.address.toLowerCase()) : [account.address.toLowerCase()];
  const outlook = sends ? isPurdue(sends) : account.provider === "outlook-forwarded";
  const [label, setLabel] = useState(account.label);
  const [job, setJob] = useState<string>(account.defaultSector ?? NONE);
  const [notify, setNotify] = useState<MailNotify>(account.notify ?? "never");
  const [error, setError] = useState<string | null>(null);
  // `own`: nobody has chosen for the address, and it still takes its provider's signature.
  const [start] = useState<(SignatureDefault & { own?: boolean })[]>(() =>
    addresses.map((address) => ({ address, ...account.signatureDefaults?.find((d) => d.address.toLowerCase() === address), ...(takesOwnSignature(account, sends, address) && { own: true }) })),
  );
  const [defaults, setDefaults] = useState(start);
  const options = [{ value: NONE, label: "None" }, ...signatures.map((s) => ({ value: s.id, label: s.name }))];
  const ownOptions = [{ value: OWN, label: "Its own signature" }, ...options];
  // A choice for either kind of mail is a choice for the address: the provider's signature is then off for both.
  const pick = (address: string, side: "newMail" | "reply", id: string) =>
    setDefaults((list) =>
      list.map((d) => {
        if (d.address !== address || id === OWN) return d;
        const { own: _own, ...chosen } = d;
        return { ...chosen, [side]: id === NONE ? undefined : id };
      }),
    );
  const done = (): void => (close ? close(onClose) : onClose());
  const save = async (): Promise<void> => {
    const sector = job === NONE ? null : (job as SectorKey);
    const patch: AccountPatch = {
      ...(label.trim() && label.trim() !== account.label && { label: label.trim() }),
      ...(sector !== (account.defaultSector ?? null) && { defaultSector: sector }),
      ...(notify !== (account.notify ?? "never") && { notify }),
      // Untouched, the signatures stay as they were: an address nobody chose for keeps its provider's.
      ...(!outlook && defaults !== start && { signatureDefaults: defaults.filter((d) => !d.own).map(({ own: _own, ...d }) => d) }),
    };
    setPending(true);
    setError(null);
    try {
      await onSave(patch);
      done();
    } catch (err) {
      setError(lifeosWords(err, "LifeOS did not save the account."));
    }
    setPending(false);
  };
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <ModalBody className="gap-0">
        <FieldRow label="Name">
          <Input aria-label="Name" value={label} disabled={pending} className="w-48" onChange={(event) => setLabel(event.target.value)} />
        </FieldRow>
        <FieldRow label="Job">
          <ChoiceSelect size="sm" className="w-48" label="Job" value={job} disabled={pending} options={[{ value: NONE, label: "None" }, ...SECTOR_KEYS.map((key) => ({ value: key, label: jobName(key) }))]} onChange={setJob} />
        </FieldRow>
        {outlook ? (
          <p className="py-3 text-xs text-muted-foreground">Outlook adds its own signature.</p>
        ) : (
          defaults.map((d) => (
            <div key={d.address} className="flex flex-col">
              {/* The title names the account's own address; only an alias is written out. */}
              {addresses.length > 1 ? <span className="truncate pt-3 text-xs font-medium text-muted-foreground">{d.address === account.address.toLowerCase() ? "Primary address" : d.address}</span> : null}
              <FieldRow label="Signature on new mail">
                <ChoiceSelect size="sm" className="w-48" label={`Signature on new mail from ${d.address}`} value={d.own ? OWN : (d.newMail ?? NONE)} disabled={pending} options={d.own ? ownOptions : options} onChange={(id) => pick(d.address, "newMail", id)} />
              </FieldRow>
              <FieldRow label="Signature on replies">
                <ChoiceSelect size="sm" className="w-48" label={`Signature on replies from ${d.address}`} value={d.own ? OWN : (d.reply ?? NONE)} disabled={pending} options={d.own ? ownOptions : options} onChange={(id) => pick(d.address, "reply", id)} />
              </FieldRow>
            </div>
          ))
        )}
        <FieldRow label="Notify me">
          <ChoiceSelect size="sm" className="w-48" label="Notify me" value={notify} disabled={pending} options={NOTIFY} onChange={setNotify} />
        </FieldRow>
        <ErrorLine error={error} />
      </ModalBody>
      <DialogFooter onCancel={done} confirmLabel="Save" pending={pending} />
    </form>
  );
}

