import {
  useCallback,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { Input } from "../components/ui/input";
import { Slider, SliderThumb, SliderTrack } from "../components/ui/slider";
import { hexToHsv, hsvToHex, normalizeHex, type Hsv } from "../lib/colorUtils";

type Props = {
  value: string;
  onChange: (hex: string) => void;
};

/** The gradients are colour data, kept literal in colourGuard's palette list.
 *  A custom colour: the saturation and brightness field, the hue strip and
 *  the hex value, laid out inline (the Customize dialog shows it under its
 *  colour row). Every part takes the keyboard: the field by its arrows (Shift
 *  for ten at a time), the strip as a slider, the hex as a field that takes
 *  typing and commits once it is a whole colour. */
export function ColorPicker({ value, onChange }: Props) {
  const [hsv, setHsv] = useState<Hsv>(() => hexToHsv(value));
  // What is being typed in the hex field, until it is a whole colour or the field is left.
  const [draft, setDraft] = useState<string | null>(null);
  const svRef = useRef<HTMLDivElement>(null);

  const applyHsv = useCallback(
    (updater: Hsv | ((prev: Hsv) => Hsv)) => {
      setHsv((prev) => {
        const next = typeof updater === "function" ? updater(prev) : updater;
        onChange(hsvToHex(next.h, next.s, next.v));
        return next;
      });
    },
    [onChange],
  );

  const onHexInput = (raw: string) => {
    setDraft(raw);
    const trimmed = raw.trim();
    if (!/^#?[0-9a-fA-F]{6}$/.test(trimmed)) return;
    const hex = trimmed.startsWith("#") ? trimmed : `#${trimmed}`;
    const next = hexToHsv(hex);
    setHsv(next);
    onChange(normalizeHex(hex));
  };

  const onSvPointer = (event: ReactPointerEvent<HTMLDivElement>) => {
    const el = svRef.current;
    if (!el) return;
    event.preventDefault();
    el.focus({ preventScroll: true });
    event.currentTarget.setPointerCapture(event.pointerId);

    const update = (clientX: number, clientY: number) => {
      const rect = el.getBoundingClientRect();
      const s = clamp01((clientX - rect.left) / rect.width) * 100;
      const v = (1 - clamp01((clientY - rect.top) / rect.height)) * 100;
      applyHsv((prev) => ({ ...prev, s, v }));
    };

    update(event.clientX, event.clientY);
    const onMove = (e: PointerEvent) => update(e.clientX, e.clientY);
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  };

  const onSvKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 10 : 1;
    const move = SV_KEYS[event.key];
    if (!move) return;
    event.preventDefault();
    applyHsv((prev) => ({ ...prev, s: clamp01((prev.s + move.s * step) / 100) * 100, v: clamp01((prev.v + move.v * step) / 100) * 100 }));
  };

  const preview = hsvToHex(hsv.h, hsv.s, hsv.v);
  const hueColor = hsvToHex(hsv.h, 100, 100);

  return (
    <div className="flex flex-col gap-2">
      <div
        ref={svRef}
        role="slider"
        tabIndex={0}
        aria-label="Saturation and brightness"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(hsv.s)}
        aria-valuetext={`Saturation ${Math.round(hsv.s)}%, brightness ${Math.round(hsv.v)}%`}
        className="focus-ring relative h-28 w-full cursor-crosshair touch-none rounded-md"
        style={{
          background: `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, ${hueColor})`,
        }}
        onPointerDown={onSvPointer}
        onKeyDown={onSvKey}
      >
        <span
          className="pointer-events-none absolute size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-foreground shadow-sm"
          style={{
            left: `${hsv.s}%`,
            top: `${100 - hsv.v}%`,
            background: preview,
          }}
        />
      </div>

      {/* The control is 24px tall for the hand; it overlaps the 8px gaps so the strip sits where it did. */}
      <Slider className="-my-1.5" value={hsv.h} min={0} max={360} step={1} largeStep={30} onValueChange={(h) => applyHsv((prev) => ({ ...prev, h: h as number }))}>
        <SliderTrack
          className="h-3"
          style={{
            background:
              "linear-gradient(to right, #f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00)",
          }}
        >
          {/* The thumb floats over the colours being picked: the one step shadow the app draws (lib/depthGuard.test.ts). */}
          <SliderThumb aria-label="Hue" getAriaValueText={(_, hue) => `${Math.round(hue)}°`} className="shadow-sm" style={{ background: hueColor }} />
        </SliderTrack>
      </Slider>

      <div className="flex items-center gap-2">
        <span className="size-7 shrink-0 rounded-md ring-1 ring-border" style={{ background: preview }} aria-hidden />
        <Input
          type="text"
          value={draft ?? preview}
          spellCheck={false}
          aria-label="Hex colour"
          onChange={(e) => onHexInput(e.target.value)}
          onBlur={() => setDraft(null)}
          className="min-w-0 flex-1 font-mono text-xs"
        />
      </div>
    </div>
  );
}

/** Where an arrow moves the field's point: saturation across, brightness up. */
const SV_KEYS: Record<string, { s: number; v: number }> = {
  ArrowLeft: { s: -1, v: 0 },
  ArrowRight: { s: 1, v: 0 },
  ArrowUp: { s: 0, v: 1 },
  ArrowDown: { s: 0, v: -1 },
};

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}
