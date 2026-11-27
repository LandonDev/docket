import { useEffect, useState, type KeyboardEvent } from "react";
import { Region } from "../../components/bones";
import { Button } from "../../components/ui/button";
import { acceleratorHint, acceleratorOf, bareKey, keyCaps } from "../../lib/keys";
import { Keys } from "../../surfaces/settings/keys";
import { SettingRow } from "../../surfaces/settings/parts/SettingRow";
import { useSaved } from "../../surfaces/settings/parts/useSaved";

/** What main answers about the capture key (src/main/capture.ts `CaptureKeyState`). */
export interface CaptureKeyState {
  key: string | null;
  defaultKey: string;
  held: boolean;
  error: string | null;
  workOn: boolean;
}

export interface CaptureKeyApi {
  get(): Promise<CaptureKeyState>;
  set(key: string | null): Promise<CaptureKeyState>;
}

/** The desktop's capture key, where this window has one (not the /ui page). */
export const captureKeyApi = (): CaptureKeyApi | null => (window as unknown as { api?: { captureKey?: CaptureKeyApi } }).api?.captureKey ?? null;

/**
 * Settings → Shortcuts → From any app → Open capture (docs/agents/work-capture.md): the key that opens the capture
 * window over any app, kept by this computer (`<userData>/capture.json`). Pressing the button records the next chord;
 * Escape keeps the key, Delete turns it off. A key another app holds is refused: the one before stays and the row's
 * red line says why.
 */
export function CaptureKeyRow({ api }: { api: CaptureKeyApi }) {
  const [state, setState] = useState<CaptureKeyState | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [asked, setAsked] = useState(0);
  const [recording, setRecording] = useState(false);

  // Until main answers the key is unknown: the button's shape, never "Off". A failed read says why, with Retry.
  useEffect(() => {
    let live = true;
    setFailed(null);
    api.get().then(
      (s) => live && setState(s),
      (err: unknown) => live && setFailed(err instanceof Error ? err.message : String(err)),
    );
    return () => {
      live = false;
    };
  }, [api, asked]);

  const saved = useSaved();
  const save = (key: string | null) => {
    setRecording(false);
    void saved.run(async () => {
      const next = await api.set(key);
      setState(next);
      if (next.error) throw new Error(next.error);
    });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (!recording) return;
    e.preventDefault();
    if (e.key === "Escape" && bareKey(e)) return setRecording(false);
    if ((e.key === "Backspace" || e.key === "Delete") && bareKey(e)) return save(null);
    const key = acceleratorOf(e.nativeEvent);
    if (key) save(key);
  };

  // Until main answers, the key's button at rest with a sample chord, as its bones: never "Off".
  return (
    <SettingRow
      id="keys.capture"
      saved={saved}
      description={recording ? "Escape to keep it, Delete to turn it off" : undefined}
      error={state ? (saved.error ?? (!recording && state.error ? state.error : undefined)) : failed}
    >
      {!state && failed ? (
        <Button variant="ghost" size="sm" onClick={() => setAsked((n) => n + 1)}>
          Retry
        </Button>
      ) : (
        <Region loading={!state} label="" bones={<KeyButton data-capture-key="loading" chord="CommandOrControl+Shift+Space" recording={false} />}>
          {state ? <KeyButton chord={state.key} recording={recording} onClick={() => setRecording((r) => !r)} onKeyDown={onKeyDown} onBlur={() => setRecording(false)} /> : null}
        </Region>
      )}
    </SettingRow>
  );
}

/** The capture key's button: the chord in key caps, "Off" with none, "Press the keys" while it records the next. */
function KeyButton({
  chord,
  recording,
  onClick,
  onKeyDown,
  onBlur,
  ...rest
}: {
  chord: string | null;
  recording: boolean;
  onClick?: () => void;
  onKeyDown?: (e: KeyboardEvent<HTMLButtonElement>) => void;
  onBlur?: () => void;
  "data-capture-key"?: string;
}) {
  const hint = chord ? acceleratorHint(chord) : "Off";
  return (
    <Button
      {...rest}
      variant="secondary"
      size="sm"
      aria-label={recording ? "Press the keys" : hint}
      aria-pressed={recording}
      onClick={onClick}
      onKeyDown={onKeyDown}
      onBlur={onBlur}
      className="min-w-28 tabular-nums"
    >
      {/* The chord in the same key caps as every other shortcut on the page. */}
      {recording ? "Press the keys" : chord ? <Keys keys={keyCaps(chordOf(chord))} className="" /> : "Off"}
    </Button>
  );
}

/** An Electron accelerator ("Command+Shift+Space") as a chord `keyCaps` reads ("mod+shift+Space"). */
export function chordOf(accelerator: string): string {
  const names: Record<string, string> = { Command: "mod", CommandOrControl: "mod", Control: "ctrl", Alt: "alt", Option: "alt", Shift: "shift", Super: "Win" };
  return accelerator
    .split("+")
    .map((part) => names[part] ?? part)
    .join("+");
}
