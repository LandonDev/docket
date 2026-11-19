import { useRef, useState, type PointerEvent as ReactPointerEvent, type ReactElement } from "react";
import type { PdfField, PdfFieldValue, PdfSignature } from "@shared/contract-work-pdf";
import { DialogFooter, ErrorLine, errorText } from "../../chrome/ConfirmDialog";
import { Check, PenLine } from "../../chrome/icons";
import { Modal, useModalClose } from "../../chrome/Modal";
import { BusyLabel, Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "../../components/ui/popover";
import { sayError } from "../canvas/frame";
import { boxStyle } from "./layout";

/**
 * A form's fields drawn over the page: what the copy that leaves will
 * carry. pdf.js draws the file's own empty widgets into the picture; this
 * layer draws the values on top. An agent's value wears the added tint on
 * paper until he takes it; the current one is outlined. A press opens the
 * field to type his own value, under where the value came from. The
 * signature and its date are his alone: an empty signature is the dashed
 * Sign of the prototype.
 */

/** A field's words, sized to its box. */
function shown(field: PdfField): PdfFieldValue {
  return field.state === "proposed" ? (field.proposed ?? null) : field.value;
}

/** The source a person reads first: "From Purdue profile", with the words it was read from. */
export function sourceLine(field: PdfField): string | null {
  const first = field.provenance[0];
  if (!first) return null;
  if (first.kind === "manual") return "Typed by you";
  return `From ${first.label}`;
}

export interface FieldActions {
  setField(key: string, value: PdfFieldValue): Promise<unknown>;
  /** A press on an empty signature: sign with the saved signature, or draw one first. */
  sign(): void;
  unsign(): Promise<unknown>;
}

export function FieldLayer({ fields, current, height, signature, actions }: { fields: readonly PdfField[]; current: string | null; height: number; signature: PdfSignature | null; actions: FieldActions }) {
  return (
    <div className="pointer-events-none absolute inset-0">
      {fields.map((field) => (
        <FieldBox key={field.key} field={field} current={field.key === current} pageHeight={height} signature={signature} actions={actions} />
      ))}
    </div>
  );
}

const PAPER_HOVER = "hover:bg-[color-mix(in_srgb,var(--paper-ink)_6%,transparent)]";
const OUTLINE = "outline-1 outline-offset-1 outline-[color-mix(in_srgb,var(--paper-ink)_40%,transparent)]";

function FieldBox({ field, current, pageHeight, signature, actions }: { field: PdfField; current: boolean; pageHeight: number; signature: PdfSignature | null; actions: FieldActions }) {
  const boxHeight = (field.bbox[3] - field.bbox[1]) * pageHeight;
  // The words keep to the box and to the paper: about 12pt at 100%, smaller as the page is.
  const size = Math.max(6, Math.min(boxHeight * 0.7, pageHeight * 0.016));
  const value = shown(field);
  const tint = field.state === "proposed" ? "bg-(--add-bg-paper)" : "";
  const place = { ...boxStyle(field.bbox), fontSize: `${size}px`, lineHeight: `${Math.max(boxHeight, size)}px` };
  const base = `pointer-events-auto absolute overflow-hidden rounded-[2px] px-[3px] text-(--paper-ink) transition-[background-color] duration-(--dur-base) ease-(--ease-out) ${tint} ${current ? OUTLINE : ""}`;

  if (field.type === "signature") {
    if (field.state === "accepted" && signature) {
      return (
        <SignedPopover field={field} actions={actions}>
          <button type="button" data-pdf-field={field.key} aria-label="Signature" style={boxStyle(field.bbox)} className={`${base} ${PAPER_HOVER} flex items-end`}>
            <Strokes signature={signature} />
          </button>
        </SignedPopover>
      );
    }
    return (
      <div data-pdf-field={field.key} style={boxStyle(field.bbox)} className={`${base} flex items-end pb-[2px]`}>
        <button
          type="button"
          onClick={actions.sign}
          className="inline-flex h-[22px] items-center gap-1 rounded-sm border border-dashed border-[color-mix(in_srgb,var(--paper-ink)_50%,transparent)] px-2 text-xs font-medium text-(--paper-ink) transition-[background-color] duration-(--dur-hover) hover:bg-[color-mix(in_srgb,var(--paper-ink)_6%,transparent)] active:bg-[color-mix(in_srgb,var(--paper-ink)_12%,transparent)] active:transition-none"
        >
          <PenLine className="size-3" />
          Sign
        </button>
      </div>
    );
  }
  if (field.type === "date" && field.state === "needs-owner") {
    // The day he signs: nothing to type, nothing to press.
    return <div data-pdf-field={field.key} style={place} className={base} />;
  }
  if (field.type === "checkbox") {
    return (
      <button
        type="button"
        role="checkbox"
        aria-checked={value === true}
        aria-label={field.label}
        data-pdf-field={field.key}
        style={boxStyle(field.bbox)}
        className={`${base} ${PAPER_HOVER} grid place-items-center px-0`}
        onClick={() => void actions.setField(field.key, value !== true).catch((error: unknown) => sayError(error, "Couldn't change the field"))}
      >
        {value === true ? <Check className="size-[80%]" /> : null}
      </button>
    );
  }
  return (
    <FieldPopover field={field} actions={actions}>
      <button type="button" data-pdf-field={field.key} aria-label={field.label} style={place} className={`${base} ${PAPER_HOVER} truncate text-start font-sans`}>
        {typeof value === "string" ? value : ""}
      </button>
    </FieldPopover>
  );
}

/** A press on a field: where its value came from, and his own value. */
function FieldPopover({ field, actions, children }: { field: PdfField; actions: FieldActions; children: ReactElement }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const source = sourceLine(field);
  const quote = field.provenance[0]?.quote;
  const save = (): void => {
    setSaving(true);
    actions
      .setField(field.key, draft.trim() === "" ? null : draft)
      .then(() => setOpen(false))
      .catch((error: unknown) => sayError(error, "Couldn't change the field"))
      .finally(() => setSaving(false));
  };
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next) setDraft(typeof shown(field) === "string" ? (shown(field) as string) : "");
        setOpen(next);
      }}
    >
      <PopoverTrigger render={children} />
      <PopoverContent align="start" className="w-72 p-3">
        <form
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            save();
          }}
        >
          <div className="min-w-0">
            <div className="truncate text-[13px] leading-5 font-medium">{field.label}</div>
            {source ? <div className="text-xs text-muted-foreground">{quote ? `${source}: “${quote}”` : source}</div> : null}
          </div>
          {field.type === "choice" && field.options?.length ? (
            <div className="flex flex-col">
              {field.options.map((option) => (
                <Button key={option} type="button" variant="ghost" size="sm" className="justify-start font-normal" onClick={() => setDraft(option)} aria-pressed={draft === option}>
                  {draft === option ? <Check /> : <span className="size-3.5" />}
                  {option}
                </Button>
              ))}
            </div>
          ) : (
            <Input value={draft} onChange={(event) => setDraft(event.target.value)} aria-label={field.label} autoFocus />
          )}
          <div className="flex justify-end">
            <Button type="submit" variant="secondary" size="sm" disabled={saving}>
              <BusyLabel busy={saving} label="Save" />
            </Button>
          </div>
        </form>
      </PopoverContent>
    </Popover>
  );
}

function SignedPopover({ field, actions, children }: { field: PdfField; actions: FieldActions; children: ReactElement }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger render={children} />
      <PopoverContent align="start" className="p-1">
        <Button
          variant="ghost"
          size="sm"
          disabled={busy}
          aria-label={`Take your signature off ${field.label}`}
          onClick={() => {
            setBusy(true);
            actions
              .unsign()
              .then(() => setOpen(false))
              .catch((error: unknown) => sayError(error, "Couldn't take the signature off"))
              .finally(() => setBusy(false));
          }}
        >
          <BusyLabel busy={busy} label="Take signature off" />
        </Button>
      </PopoverContent>
    </Popover>
  );
}

/** A drawn signature, scaled into its box. */
export function Strokes({ signature }: { signature: PdfSignature }) {
  return (
    <svg viewBox={`0 0 ${signature.width} ${signature.height}`} preserveAspectRatio="xMinYMax meet" className="size-full text-(--paper-ink)" aria-hidden="true">
      {signature.strokes.map((stroke, index) => (
        <polyline key={index} points={stroke.map(([x, y]) => `${x},${y}`).join(" ")} fill="none" stroke="currentColor" strokeWidth={Math.max(2, signature.width / 160)} strokeLinecap="round" strokeLinejoin="round" />
      ))}
    </svg>
  );
}

const PAD = { width: 480, height: 160 };

/** Draws his signature once; it is kept on this host and placed with every Sign after. Mounted only while it is open. */
export function SignaturePad({ onClose, onSave }: { onClose(): void; onSave(signature: PdfSignature): Promise<unknown> }) {
  const [pending, setPending] = useState(false);
  return (
    <Modal onClose={onClose} busy={pending} title="Your signature" size="sm">
      <Pad onClose={onClose} onSave={onSave} pending={pending} setPending={setPending} />
    </Modal>
  );
}

function Pad({ onClose, onSave, pending, setPending }: { onClose(): void; onSave(signature: PdfSignature): Promise<unknown>; pending: boolean; setPending(on: boolean): void }) {
  const close = useModalClose();
  const [strokes, setStrokes] = useState<Array<Array<[number, number]>>>([]);
  const [error, setError] = useState<string | null>(null);
  const drawing = useRef(false);
  const point = (event: ReactPointerEvent<SVGSVGElement>): [number, number] => {
    const r = event.currentTarget.getBoundingClientRect();
    return [Math.round(((event.clientX - r.left) / Math.max(1, r.width)) * PAD.width), Math.round(((event.clientY - r.top) / Math.max(1, r.height)) * PAD.height)];
  };
  const save = (): void => {
    setPending(true);
    setError(null);
    onSave({ ...PAD, strokes }).then(
      () => {
        setPending(false);
        if (close) close(onClose);
        else onClose();
      },
      (err: unknown) => {
        setPending(false);
        setError(errorText(err));
      },
    );
  };
  return (
    <>
      <div className="flex flex-col gap-3 px-5 py-4">
        <svg
          data-signature-pad
          viewBox={`0 0 ${PAD.width} ${PAD.height}`}
          className="aspect-[3/1] w-full touch-none rounded-lg bg-(--paper) text-(--paper-ink) outline-1 -outline-offset-1 outline-(--image-outline)"
          onPointerDown={(event) => {
            if (drawing.current) return;
            drawing.current = true;
            event.currentTarget.setPointerCapture(event.pointerId);
            setStrokes((all) => [...all, [point(event)]].slice(-200));
          }}
          onPointerMove={(event) => {
            if (!drawing.current) return;
            const p = point(event);
            setStrokes((all) => {
              const last = all.at(-1);
              if (!last || last.length >= 4000) return all;
              return [...all.slice(0, -1), [...last, p]];
            });
          }}
          onPointerUp={() => (drawing.current = false)}
          onPointerCancel={() => (drawing.current = false)}
        >
          {strokes.map((stroke, index) => (
            <polyline key={index} points={stroke.map(([x, y]) => `${x},${y}`).join(" ")} fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" />
          ))}
        </svg>
        <ErrorLine error={error} />
      </div>
      <DialogFooter
        onCancel={onClose}
        confirmLabel="Sign"
        pending={pending}
        disabled={strokes.length === 0}
        onConfirm={save}
        start={
          <Button variant="ghost" disabled={strokes.length === 0 || pending} onClick={() => setStrokes([])}>
            Clear
          </Button>
        }
      />
    </>
  );
}
