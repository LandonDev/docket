import { useEffect, useState, type ReactNode } from "react";
import { GroupInput, InputGroup } from "../../../components/ui/input";
import { bareKey } from "../../../lib/keys";

/** The Format sheet's parts, which both its tabs lay out with (docs/DESIGN.md "The slide editor"). */

/** A field he types a value into: it is sent when he leaves it or presses Return, and put back by Escape or a value it cannot read. */
export function NumberField({ label, lead, value, read, onSet, disabled }: { label: string; lead?: string; value: string; read(text: string): number | null; onSet(v: number): void; disabled?: boolean }) {
  const [text, setText] = useState(value);
  const [held, setHeld] = useState(false);
  useEffect(() => {
    if (!held) setText(value);
  }, [value, held]);
  const commit = (): void => {
    setHeld(false);
    // Left as it was shown: nothing to write (what is shown is rounded, and must not move the shape by the rounding).
    if (text.trim() === value) return;
    const v = read(text);
    if (v === null) return setText(value);
    onSet(v);
  };
  return (
    <InputGroup className="h-7 rounded-md px-2" leading={lead ? <span className="text-xs leading-5 text-muted-foreground">{lead}</span> : undefined}>
      <GroupInput
        aria-label={label}
        value={text}
        disabled={disabled}
        inputMode="decimal"
        autoComplete="off"
        spellCheck={false}
        className="text-[13px] tabular-nums"
        onFocus={(e) => {
          setHeld(true);
          e.currentTarget.select();
        }}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter" && bareKey(e)) {
            e.preventDefault();
            commit();
          } else if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            setText(value);
            e.currentTarget.blur();
          }
        }}
      />
    </InputGroup>
  );
}

export function Section({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section aria-label={label} className="flex flex-col gap-2">
      <h3 className="text-xs leading-4 font-medium text-muted-foreground">{label}</h3>
      {children}
    </section>
  );
}

export function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-h-7 items-center justify-between gap-3 text-[13px] leading-5">
      <span className="min-w-0 truncate">{label}</span>
      <div className="flex shrink-0 items-center gap-0.5">{children}</div>
    </div>
  );
}
