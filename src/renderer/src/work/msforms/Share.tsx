import { useEffect, useState } from "react";
import QRCode from "qrcode";
import type { MsFormView } from "@shared/contract-work-msforms";
import { isOther } from "@shared/work/msforms";
import { DialogFooter } from "../../chrome/ConfirmDialog";
import { Field } from "../../chrome/DialogField";
import { Modal } from "../../chrome/Modal";
import { BusyLabel, Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Skeleton } from "../../components/ui/skeleton";
import { sayError } from "../canvas/frame";

/**
 * Sharing a Microsoft form's link on his own press (docs/agents/work-msforms.md "Sharing extras"): its QR code to show
 * or copy as a picture, and a prefilled link Forms makes for the answers he types. Nothing here sends anything.
 */

/** The QR code of the response link, drawn here from the link alone. */
export function QrDialog({ link, title, onClose }: { link: string; title: string; onClose(): void }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let on = true;
    void QRCode.toDataURL(link, { margin: 1, width: 240, color: { dark: "#000000", light: "#ffffff" } }).then(
      (url) => on && setSrc(url),
      () => on && sayError(null, "Couldn't draw the QR code"),
    );
    return () => {
      on = false;
    };
  }, [link]);
  const copy = async (): Promise<void> => {
    if (!src) return;
    try {
      const blob = await (await fetch(src)).blob();
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
    } catch (err) {
      sayError(err, "Couldn't copy the picture");
    }
  };
  return (
    <Modal title={title} description="People who scan it open the form." size="sm" onClose={onClose}>
      <div className="flex justify-center py-2">{src ? <img data-msform-qr src={src} alt={`QR code for ${link}`} width={240} height={240} className="rounded-md" /> : <Skeleton className="size-60" />}</div>
      <DialogFooter>
        <Button variant="secondary" size="sm" disabled={!src} onClick={() => void copy()}>
          Copy Picture
        </Button>
      </DialogFooter>
    </Modal>
  );
}

/** Forms' Get Pre-filled URL for the answers he types: one field a question it can fill. */
export function PrefillDialog({ view, make, onClose }: { view: MsFormView; make(values: Record<string, string>): Promise<{ link: string }>; onClose(): void }) {
  const questions = view.questions.filter((q) => !isOther(q) && q.type !== "section");
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [link, setLink] = useState<string | null>(null);
  const filled = Object.fromEntries(Object.entries(values).filter(([, v]) => v.trim()));
  const run = (): void => {
    setBusy(true);
    void make(filled)
      .then(
        (r) => setLink(r.link),
        (err: unknown) => sayError(err, "Forms did not make the link"),
      )
      .finally(() => setBusy(false));
  };
  return (
    <Modal title="Prefilled Link" size="md" busy={busy} onClose={onClose}>
      <div className="flex flex-col gap-3">
        {questions.map((q) => (
          <Field key={q.title} label={q.title}>
            <Input value={values[q.title] ?? ""} onChange={(e) => setValues({ ...values, [q.title]: e.target.value })} />
          </Field>
        ))}
        {link ? (
          <Field label="Link">
            <Input readOnly value={link} onFocus={(e) => e.currentTarget.select()} />
          </Field>
        ) : null}
      </div>
      <DialogFooter>
        {link ? (
          <Button variant="secondary" size="sm" onClick={() => void navigator.clipboard.writeText(link).catch(() => sayError(null, "Couldn't copy the link"))}>
            Copy Link
          </Button>
        ) : null}
        <Button size="sm" disabled={busy || !Object.keys(filled).length} onClick={run}>
          <BusyLabel busy={busy} label="Get Link" />
        </Button>
      </DialogFooter>
    </Modal>
  );
}
