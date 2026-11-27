import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { DialogFooter } from "../../chrome/ConfirmDialog";
import { Check, Copy } from "../../chrome/icons";
import { Modal } from "../../chrome/Modal";
import { Button } from "../../components/ui/button";
import { Bone, Region } from "../../components/bones";
import { sayError } from "../canvas/frame";

/**
 * Sharing a Microsoft form's link on his own press (docs/agents/work-msforms.md "Sharing extras"): its QR code to show
 * or copy as a picture. Nothing here sends anything.
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
  // Copied answers the press for 1.5 s, as the bar's Copy link does.
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);
  const copy = async (): Promise<void> => {
    if (!src) return;
    try {
      const blob = await (await fetch(src)).blob();
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      setCopied(true);
    } catch (err) {
      sayError(err, "Couldn't copy the picture");
    }
  };
  return (
    <Modal title={title} description="People who scan it open the form." size="sm" onClose={onClose}>
      <Region loading={!src} label="Drawing the QR code" className="items-center py-2" bones={<Bone className="size-60 rounded-md" />}>
        {src ? <img data-msform-qr src={src} alt={`QR code for ${link}`} width={240} height={240} className="rounded-md" /> : null}
      </Region>
      <DialogFooter>
        <Button variant="secondary" size="sm" disabled={!src} onClick={() => void copy()}>
          {copied ? <Check /> : <Copy />}
          {copied ? "Copied" : "Copy picture"}
        </Button>
      </DialogFooter>
    </Modal>
  );
}
