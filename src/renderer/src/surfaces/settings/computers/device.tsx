import { useEffect, useId, useState } from "react";
import QRCode from "qrcode";
import type { RemoteKey, RemotePairing, RemoteStatus } from "@server/shared/contract-remote";
import { ChoiceToggle } from "../../../components/choice-toggle";
import { BusyLabel, Button } from "../../../components/ui/button";
import { Input } from "../../../components/ui/input";
import { RadioChoice, RadioGroup } from "../../../components/ui/radio-group";
import { ConfirmDialog, DialogFooter, ErrorLine } from "../../../chrome/ConfirmDialog";
import { Field, FieldRow } from "../../../chrome/DialogField";
import { ModalBody, useModalClose } from "../../../chrome/Modal";
import { LOCAL_ENVIRONMENT_ID, registry } from "../../../lib/connection";
import { computerInLine, useComputerName } from "../../../lib/settings/computerName";
import { hostRequest } from "../parts/hostRpc";
import { ALLOW_CAPS, BOT_ALLOWS, addErrorWords, allowChoices, capital, type Allow } from "./addWords";
import { ChoiceField, CopyWordsButton, Secret, useFrame } from "./frame";

/**
 * Sign a device in to <computer> (docs/agents/settings.md "Add a computer"): a phone, a browser or a computer that
 * already runs Docket gets a one-use sign-in link with its code and QR; a bot gets a key, shown once. Both are made
 * on the computer the title names, over that computer's own link, and on no other.
 */

type Pairing = { pairing: RemotePairing; code: string; url: string };
/** `url` null: no other device reaches the computer yet, so no link is offered, nor its QR. */
export type MadeLink = Omit<Pairing, "url"> & { url: string | null; qr: string | null };
export type MadeKey = { key: RemoteKey; token: string; webhookSecret?: string };
/** The address other devices reach the computer at, as it says it. Null: none yet. Undefined: not known. */
type Reach = string | null | undefined;
type Kind = "device" | "bot";

/** A link on a computer's own address (no web address is set), which no other device can open. */
export const loopbackLink = (url: string): boolean => {
  try {
    return /^(127\.\d+\.\d+\.\d+|localhost|\[::1\])$/i.test(new URL(url).hostname);
  } catch {
    return false;
  }
};

/** The address a sign-in link starts with (docs/agents/remote-access.md "Pairing"): never the loopback fallback. */
export const outsideOrigin = (status: Pick<RemoteStatus, "publicOrigin" | "learnedOrigin">): string | null => status.publicOrigin || status.learnedOrigin || null;

/** The link a sign-in is offered by: on the computer's outside address; none where it has none; its own where it did not say. */
export const pairLink = (reach: Reach, made: Pairing): string | null => (reach === null ? null : reach ? `${reach.replace(/\/+$/, "")}/pair#${made.code}` : made.url);

/** The link as the dialog shows it under the code: its address and path, the code left off. */
export const shortLink = (url: string): string => {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}`;
  } catch {
    return url;
  }
};

/** What the computer says of its reach; undefined where it does not say. */
const reachOf = (computer: string): Promise<Reach> =>
  hostRequest<RemoteStatus | undefined>(computer, "remote.status", {}).then(
    (status) => (status ? outsideOrigin(status) : undefined),
    () => undefined,
  );

const QR = { margin: 1, width: 192, color: { dark: "#000000", light: "#ffffff" } };

export type DeviceWayProps = {
  /** The environment id of the computer the device signs in to; this window's own by default (at /ui, the box it serves). */
  computer?: string;
  onClose: () => void;
  onChanged: () => void;
  /** Start on the bot (the old New key…). */
  bot?: boolean;
  /** Start on a link or key already made (ui:preview's fixtures). */
  made?: MadeLink;
  madeKey?: MadeKey;
  /** The computer as a sentence names it, where the window cannot say (ui:preview has no computer of its own). */
  inLine?: string;
};

export function DeviceWay({ computer = registry.primaryEnvironmentId, onClose, onChanged, bot = false, made: madeAtFirst, madeKey: keyAtFirst, inLine: said }: DeviceWayProps) {
  const name = useComputerName(computer);
  const inLine = said ?? computerInLine(name);
  const [made, setMade] = useState<MadeLink | null>(madeAtFirst ?? null);
  const [madeKey, setMadeKey] = useState<MadeKey | null>(keyAtFirst ?? null);
  const [pending, setPending] = useState(false);
  const [kind, setKind] = useState<Kind>(bot ? "bot" : "device");
  useFrame({
    title: `Sign a device in to ${inLine}`,
    description: madeKey ? "Shown once. Copy it now." : made ? undefined : kind === "bot" ? "A bot signs in with a key, shown once." : "A phone, a browser, or a computer that already runs Docket.",
    endsAt: made && !madeKey ? made.pairing.expiresAt : undefined,
    busy: pending,
  });
  if (madeKey) return <KeyShown made={madeKey} onClose={onClose} />;
  if (made) return <LinkShown made={made} computer={computer} inLine={inLine} onClose={onClose} onChanged={onChanged} />;
  return <DeviceForm computer={computer} inLine={inLine} kind={kind} setKind={setKind} pending={pending} setPending={setPending} onClose={onClose} onChanged={onChanged} onLink={setMade} onKey={setMadeKey} />;
}

function DeviceForm({
  computer,
  inLine,
  kind,
  setKind,
  pending,
  setPending,
  onClose,
  onChanged,
  onLink,
  onKey,
}: {
  computer: string;
  inLine: string;
  kind: Kind;
  setKind: (kind: Kind) => void;
  pending: boolean;
  setPending: (on: boolean) => void;
  onClose: () => void;
  onChanged: () => void;
  onLink: (made: MadeLink) => void;
  onKey: (made: MadeKey) => void;
}) {
  const allowId = useId();
  const [name, setName] = useState("");
  const [allow, setAllow] = useState<Allow>("run");
  const [webhookUrl, setWebhookUrl] = useState("");
  const [webhookSecret, setWebhookSecret] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const [reach, setReach] = useState<Reach>(undefined);
  useEffect(() => {
    let live = true;
    void reachOf(computer).then((next) => live && setReach(next));
    return () => void (live = false);
  }, [computer]);

  const choices = allowChoices(inLine).filter((choice) => kind === "device" || BOT_ALLOWS.includes(choice.value));
  const pickKind = (next: Kind): void => {
    setKind(next);
    if (next === "bot" && !BOT_ALLOWS.includes(allow)) setAllow("run");
  };

  const make = async (): Promise<void> => {
    setPending(true);
    setError(null);
    try {
      const caps = ALLOW_CAPS[allow];
      if (kind === "bot") {
        const url = webhookUrl.trim();
        const secret = webhookSecret.trim();
        onKey(
          await hostRequest<MadeKey>(computer, "remote.keys.create", {
            name: name.trim(),
            audience: "mcp",
            caps,
            ...(url ? { webhookUrl: url } : {}),
            ...(url && secret ? { webhookSecret: secret } : {}),
          }),
        );
      } else {
        const next = await hostRequest<Pairing>(computer, "remote.pairings.create", { name: name.trim(), audience: "client", caps });
        // A press before the computer said its reach waits for the answer: the loopback link is never a guess.
        const url = pairLink(reach === undefined ? await reachOf(computer) : reach, next);
        // A QR only of a link another device can open.
        const qr = url && !loopbackLink(url) ? await QRCode.toDataURL(url, QR).catch(() => null) : null;
        onLink({ ...next, url, qr });
      }
      onChanged();
    } catch (err) {
      setError(addErrorWords(err, inLine));
    } finally {
      setPending(false);
    }
  };
  // Managing the computer widens what the device may do: it asks first.
  const press = (): void => {
    if (!name.trim() || pending) return;
    if (kind === "device" && allow === "manage") setAsking(true);
    else void make();
  };
  const verb = kind === "bot" ? "Make the key" : allow === "manage" ? `Make a link that can manage ${inLine}` : "Make the link";

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        press();
      }}
    >
      <ModalBody>
        <Field label="Name">
          <Input value={name} autoFocus onChange={(e) => setName(e.target.value)} placeholder={kind === "bot" ? "grok" : "iPhone"} spellCheck={false} autoComplete="off" />
        </Field>
        <FieldRow label="For">
          <ChoiceToggle<Kind>
            label="For"
            value={kind}
            onChange={pickKind}
            options={[
              { value: "device", label: "A device" },
              { value: "bot", label: "A bot" },
            ]}
          />
        </FieldRow>
        <ChoiceField label="It may" id={allowId}>
          <RadioGroup aria-labelledby={allowId} value={allow} onValueChange={(value) => setAllow(value as Allow)}>
            {choices.map((choice) => (
              <RadioChoice key={choice.value} value={choice.value} label={choice.label} description={choice.description} />
            ))}
          </RadioGroup>
        </ChoiceField>
        {kind === "bot" ? (
          <>
            <Field label="Webhook URL" aside={<span className="text-xs text-muted-foreground">Optional</span>}>
              <Input value={webhookUrl} onChange={(e) => setWebhookUrl(e.target.value)} placeholder="https://bot.example.com/hook" spellCheck={false} autoComplete="off" />
            </Field>
            {webhookUrl.trim() ? (
              <Field label="Signing secret">
                <Input value={webhookSecret} onChange={(e) => setWebhookSecret(e.target.value)} placeholder="Made for you when empty" spellCheck={false} autoComplete="off" />
              </Field>
            ) : null}
          </>
        ) : reach === null ? (
          <Unreachable computer={computer} inLine={inLine} />
        ) : null}
        <ErrorLine error={error} />
      </ModalBody>
      <DialogFooter onCancel={onClose} confirmLabel={verb} pending={pending} disabled={!name.trim()} />
      {asking ? (
        <ConfirmDialog
          title={`Let this device manage ${inLine}?`}
          body={`It can add and remove devices, change every setting on ${inLine}, and run and approve threads.`}
          confirmLabel="Make the link"
          onCancel={() => setAsking(false)}
          onConfirm={() => {}}
          onDone={() => {
            setAsking(false);
            void make();
          }}
        />
      ) : null}
    </form>
  );
}

/** Why there is no link: said before it is made, and beside the code where the answer came after his press. */
function Unreachable({ computer, inLine }: { computer: string; inLine: string }) {
  const own = computer === LOCAL_ENVIRONMENT_ID || computer === registry.primaryEnvironmentId;
  return (
    <p data-pair-unreachable className="text-xs text-muted-foreground">
      {`Other devices cannot reach ${inLine} yet. Set its Web address ${own ? "in Sharing" : "on its page"}, under Advanced.`}
    </p>
  );
}

/** The link, its code and QR, live until it ends. Cancel the link takes it back; Done keeps it for the device. */
function LinkShown({ made, computer, inLine, onClose, onChanged }: { made: MadeLink; computer: string; inLine: string; onClose: () => void; onChanged: () => void }) {
  const close = useModalClose();
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancel = async (): Promise<void> => {
    setCancelling(true);
    setError(null);
    try {
      await hostRequest(computer, "remote.pairings.revoke", { id: made.pairing.id });
      onChanged();
      if (close) close(onClose);
      else onClose();
    } catch (err) {
      setError(addErrorWords(err, inLine));
      setCancelling(false);
    }
  };
  return (
    <>
      <ModalBody>
        <div className="flex items-center gap-4">
          {made.qr ? <img src={made.qr} alt="Sign-in QR code" className="size-32 shrink-0 rounded-lg outline outline-1 -outline-offset-1 outline-image-outline" /> : null}
          <div className="flex min-w-0 flex-1 flex-col items-start">
            <code data-pairing-code className="font-mono text-lg tabular-nums text-foreground">
              {made.code}
            </code>
            {/* The whole link rides the attribute for scripts (J54); the line shows its address. */}
            {made.url ? (
              <span data-sign-in-link={made.url} className="max-w-full truncate text-xs text-muted-foreground">
                {shortLink(made.url)}
              </span>
            ) : null}
            <div className="mt-3">
              <CopyWordsButton text={made.url ?? made.code} label={made.url ? "Copy link" : "Copy code"} />
            </div>
          </div>
        </div>
        {made.url && loopbackLink(made.url) ? <p data-link-local className="text-xs text-muted-foreground">{`${capital(inLine)} has no web address, so this link opens only on it.`}</p> : null}
        {made.url ? null : <Unreachable computer={computer} inLine={inLine} />}
        <ErrorLine error={error} />
      </ModalBody>
      <DialogFooter busy={cancelling} confirmLabel="Done" closeOnConfirm onConfirm={onClose}>
        <Button data-link-cancel variant="secondary" disabled={cancelling} onClick={() => void cancel()}>
          <BusyLabel busy={cancelling} label="Cancel the link" />
        </Button>
      </DialogFooter>
    </>
  );
}

/** A bot's key, shown once. Nothing is left to cancel once it exists: Done alone. */
function KeyShown({ made, onClose }: { made: MadeKey; onClose: () => void }) {
  return (
    <>
      <ModalBody>
        <Secret label="Key" value={made.token} />
        {made.webhookSecret ? <Secret label="Signing secret" value={made.webhookSecret} /> : null}
      </ModalBody>
      <DialogFooter confirmLabel="Done" closeOnConfirm onConfirm={onClose} />
    </>
  );
}
