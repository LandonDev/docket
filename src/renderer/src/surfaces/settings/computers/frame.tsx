import { createContext, useContext, useEffect, useLayoutEffect, useState, type ReactNode } from "react";
import { Button } from "../../../components/ui/button";
import { cn } from "../../../lib/cn";
import { Input } from "../../../components/ui/input";
import { Field } from "../../../chrome/DialogField";
import { copyText, COPIED_MS } from "../../../lib/clipboard";
import { CopyButton } from "../parts/CopyButton";
import { endsText } from "./addWords";

/**
 * What the one dialog's frame shows for the step a way is on: its title, the line under it, and whether work is in
 * flight (Escape and the close button wait). A way says it with `useFrame`; the dialog draws it, so moving from the
 * choice of four to a way, or from a way's form to its link, keeps one dialog on screen.
 */
export type Frame = {
  title: string;
  description?: string;
  /** The line counts down to this time: "One use. Ends in 10 minutes." */
  endsAt?: number;
  busy?: boolean;
};

export const FrameContext = createContext<(frame: Frame) => void>(() => {});

export function useFrame({ title, description, endsAt, busy = false }: Frame): void {
  const set = useContext(FrameContext);
  useLayoutEffect(() => set({ title, description, endsAt, busy }), [set, title, description, endsAt, busy]);
}

/** Seconds left until `at`, ticking each second. */
export function useSecondsLeft(at: number): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  return Math.max(0, Math.round((at - now) / 1000));
}

/** The frame's line for a link: "One use. Ends in 10 minutes.", counting down. */
export function Ends({ at }: { at: number }) {
  return <span data-link-ends>{endsText(useSecondsLeft(at))}</span>;
}

/** A labelled group of choices (It may, the way to add, what a new computer gets): the label as Field draws its own. */
export function ChoiceField({ label, id, hint, children }: { label: string; id: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span id={id} className="text-xs font-medium text-muted-foreground">
        {label}
      </span>
      {children}
      {hint ? (
        <p data-choice-hint className="text-xs text-muted-foreground">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

/** A value shown once (a key, a link): read-only in the mono face, the copy button beside it. */
export function Secret({ label, value, hint }: { label: string; value: string; hint?: ReactNode }) {
  return (
    <Field label={label} hint={hint}>
      <SecretValue label={label} value={value} />
    </Field>
  );
}

/** Secret's control: takes the id and hint wiring its `Field` hands it. */
function SecretValue({ value, label, id, "aria-describedby": describedBy }: { value: string; label: string; id?: string; "aria-describedby"?: string }) {
  return (
    <div className="flex items-center gap-1">
      <Input id={id} aria-describedby={describedBy} readOnly value={value} spellCheck={false} onFocus={(e) => e.currentTarget.select()} className="flex-1 font-mono text-xs" />
      <CopyButton text={value} label={`Copy ${label.toLowerCase()}`} />
    </div>
  );
}

/** A button that copies and says so for a moment: "Copy link", then "Copied". */
export function CopyWordsButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), COPIED_MS);
    return () => window.clearTimeout(timer);
  }, [copied]);
  return (
    <Button variant="secondary" size="sm" aria-label={label} onClick={() => void copyText(text).then(() => setCopied(true), () => setCopied(false))}>
      {/* Both words hold the cell, so the button keeps its width when it says Copied. */}
      <span aria-hidden className="grid">
        <span className={cn("col-start-1 row-start-1", copied && "invisible")}>{label}</span>
        <span data-copied={copied || undefined} className={cn("col-start-1 row-start-1", !copied && "invisible")}>
          Copied
        </span>
      </span>
    </Button>
  );
}
