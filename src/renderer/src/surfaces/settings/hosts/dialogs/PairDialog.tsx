import { useState } from "react";
import QRCode from "qrcode";
import type { Capability } from "@server/shared/capabilities";
import type { RemotePairing, SavedEnvironment } from "@server/shared/contract-remote";
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
type Made = Pairing & { qr: string | null };
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

export function PairDialog(props: Props) {
  const [pending, setPending] = useState(false);
  const [made, setMade] = useState<Made | null>(null);
  return (
    <Modal onClose={props.onClose} busy={pending} title={props.host ? `Pair a device with ${props.host.name}` : "Pair a device"} size="sm">
      {made ? <Code made={made} {...props} /> : <Form {...props} pending={pending} setPending={setPending} onMade={setMade} />}
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
        <Secret label="Link" value={made.url} />
        {loopbackLink(made.url) ? <p className="text-xs text-muted-foreground">{host ? host.name : "This computer"} has no public address, so this link opens only there.</p> : null}
      </div>
      <DialogFooter onCancel={() => void cancel()} confirmLabel="Done" onConfirm={() => (close ? close(onClose) : onClose())} />
    </>
  );
}

function Form({ host, onClose, onChanged, pending, setPending, onMade }: Props & { pending: boolean; setPending: (on: boolean) => void; onMade: (made: Made) => void }) {
  const [name, setName] = useState("");
  const [caps, setCaps] = useState<Capability[]>(["operate"]);
  const [error, setError] = useState<string | null>(null);

  const create = async () => {
    setPending(true);
    setError(null);
    try {
      const next = await askOf(host)<Pairing>("remote.pairings.create", { name: name.trim(), audience: "client", caps });
      const qr = await QRCode.toDataURL(next.url, { margin: 1, width: 192, color: { dark: "#000000", light: "#ffffff" } }).catch(() => null);
      onMade({ ...next, qr });
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
        <ErrorLine error={error} />
      </div>
      <DialogFooter onCancel={onClose} confirmLabel="Create code" pending={pending} disabled={!name.trim()} />
    </form>
  );
}
