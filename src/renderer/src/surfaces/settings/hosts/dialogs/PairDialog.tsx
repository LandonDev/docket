import { useEffect, useState } from "react";
import QRCode from "qrcode";
import type { Capability } from "@server/shared/capabilities";
import type { RemotePairing, RemoteStatus, SavedEnvironment } from "@server/shared/contract-remote";
import { Input } from "@renderer/components/ui/input";
import { DialogFooter, ErrorLine, errorText } from "../../../../chrome/ConfirmDialog";
import { Field, FieldRow } from "../../../../chrome/DialogField";
import { Modal, useModalClose } from "../../../../chrome/Modal";
import { registry } from "../../../../lib/connection";
import { CopyButton } from "../CopyButton";
import { Facts } from "../Facts";
import { rpc } from "../rpc";
import { CapsPicker, Countdown, Secret, grantText } from "./fields";

type Pairing = { pairing: RemotePairing; code: string; url: string };
/** `url` null: no other device reaches the host yet, so no link is offered, nor its QR. */
type Made = Omit<Pairing, "url"> & { url: string | null; qr: string | null };
/** The address other devices reach the host at, as it says it: the Public origin he set, else the one learned from the tunnel. Null: none yet. Undefined: not known (the host did not say). */
type Reach = string | null | undefined;
/** `host`: a paired host this window holds an admin key on (the box): the pairing is that host's, asked over its own link. None: this machine's. */
type Props = { host?: SavedEnvironment; onClose: () => void; onChanged: () => Promise<void> };

/** The request goes to the host the pairing is for. */
const askOf =
  (host: SavedEnvironment | undefined) =>
  <T,>(method: string, params: unknown): Promise<T> =>
    host ? registry.linkOf(host.id).request<T>(method, params) : rpc<T>(method, params);

/** A link on this computer's own address (no public one is set), which no other device can open. */
export const loopbackLink = (url: string): boolean => {
  try {
    return /^(127\.\d+\.\d+\.\d+|localhost|\[::1\])$/i.test(new URL(url).hostname);
  } catch {
    return false;
  }
};

/** The address a pairing link starts with (docs/agents/remote-access.md "Pairing"): never the loopback fallback, which no other device opens. */
export const outsideOrigin = (status: Pick<RemoteStatus, "publicOrigin" | "learnedOrigin">): string | null => status.publicOrigin || status.learnedOrigin || null;

/** The link a pairing is offered by: on the host's outside address; none where it has none; the host's own where it did not say. */
export const pairLink = (reach: Reach, made: Pairing): string | null => (reach === null ? null : reach ? `${reach.replace(/\/+$/, "")}/pair#${made.code}` : made.url);

/** What the host says of its reach; undefined where it does not say. */
const reachOf = (host: SavedEnvironment | undefined): Promise<Reach> =>
  askOf(host)<RemoteStatus | undefined>("remote.status", {}).then(
    (status) => (status ? outsideOrigin(status) : undefined),
    () => undefined,
  );

export function PairDialog(props: Props) {
  const [pending, setPending] = useState(false);
  const [made, setMade] = useState<Made | null>(null);
  const [reach, setReach] = useState<Reach>(undefined);
  useEffect(() => {
    let live = true;
    void reachOf(props.host).then((next) => live && setReach(next));
    return () => void (live = false);
  }, [props.host]);
  return (
    <Modal onClose={props.onClose} busy={pending} title={props.host ? `Pair a device with ${props.host.name}` : "Pair a device"} size="sm">
      {made ? <Code made={made} {...props} /> : <Form {...props} reach={reach} pending={pending} setPending={setPending} onMade={setMade} />}
    </Modal>
  );
}

/** Step two: the code, its QR and the link, live until it expires. */
function Code({ made, host, onClose, onChanged }: Props & { made: Made }) {
  const close = useModalClose();
  // Cancel takes the code back; Done keeps it for the device to redeem.
  const cancel = async () => {
    await askOf(host)("remote.pairings.revoke", { id: made.pairing.id }).catch(() => undefined);
    await onChanged();
    onClose();
  };
  return (
    <>
      <div className="flex flex-col gap-4 px-5 py-4">
        <div className="flex items-center gap-4">
          {made.qr ? <img src={made.qr} alt="Pairing QR code" className="size-32 shrink-0 rounded-lg outline outline-1 -outline-offset-1 outline-image-outline" /> : null}
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="text-xs font-medium text-muted-foreground">Code</span>
            <div className="flex items-center gap-1">
              <code data-pairing-code className="font-mono text-lg tabular-nums text-foreground">
                {made.code}
              </code>
              <CopyButton text={made.code} label="Copy code" />
            </div>
            <Facts
              className="text-xs text-muted-foreground"
              parts={[grantText(made.pairing.caps), <Countdown key="expires" prefix="expires in" at={made.pairing.expiresAt} />]}
            />
          </div>
        </div>
        {made.url ? <Secret label="Link" value={made.url} hint={loopbackLink(made.url) ? `${host ? host.name : "This computer"} has no public address, so this link opens only there.` : undefined} /> : null}
      </div>
      <DialogFooter onCancel={() => void cancel()} confirmLabel="Done" onConfirm={() => (close ? close(onClose) : onClose())} />
    </>
  );
}

function Form({ host, reach, onClose, onChanged, pending, setPending, onMade }: Props & { reach: Reach; pending: boolean; setPending: (on: boolean) => void; onMade: (made: Made) => void }) {
  const [name, setName] = useState("");
  const [caps, setCaps] = useState<Capability[]>(["operate"]);
  const [error, setError] = useState<string | null>(null);

  const create = async () => {
    setPending(true);
    setError(null);
    try {
      const next = await askOf(host)<Pairing>("remote.pairings.create", { name: name.trim(), audience: "client", caps });
      // A press before the host answered waits for its answer: the loopback link is never a guess.
      const url = pairLink(reach === undefined ? await reachOf(host) : reach, next);
      // A QR only of a link another device can open.
      const qr = url && !loopbackLink(url) ? await QRCode.toDataURL(url, { margin: 1, width: 192, color: { dark: "#000000", light: "#ffffff" } }).catch(() => null) : null;
      onMade({ ...next, url, qr });
      await onChanged();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setPending(false);
    }
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (name.trim()) void create();
      }}
    >
      <div className="flex flex-col gap-4 px-5 py-4">
        <Field label="Name">
          <Input value={name} autoFocus onChange={(e) => setName(e.target.value)} placeholder="iPhone" />
        </Field>
        <FieldRow label="May">
          <CapsPicker value={caps} audience="client" onChange={setCaps} />
        </FieldRow>
        {reach === null ? (
          <p data-pair-unreachable className="text-xs text-muted-foreground">
            {host ? `Other devices cannot reach ${host.name} yet. Set its Public origin in Settings → Hosts on ${host.name}.` : "Other devices cannot reach this computer yet. Set its Public origin on this page."}
          </p>
        ) : null}
        <ErrorLine error={error} />
      </div>
      <DialogFooter onCancel={onClose} confirmLabel="Create code" pending={pending} disabled={!name.trim()} />
    </form>
  );
}
