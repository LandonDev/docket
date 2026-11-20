import { useEffect, useState, type KeyboardEvent } from "react";
import { PageRow } from "../../components/page";
import { Button } from "../../components/ui/button";
import { acceleratorHint, acceleratorOf, bareKey } from "../../lib/keys";

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
 * Settings → Work's capture key (docs/agents/work-capture.md): the key that
 * opens the capture window over any app. Pressing the button records the
 * next chord; Escape keeps the key, Delete turns it off. A key another app
 * holds is refused and the one before stays.
 */
export function CaptureKeyRow({ api }: { api: CaptureKeyApi }) {
  const [state, setState] = useState<CaptureKeyState | null>(null);
  const [recording, setRecording] = useState(false);

  useEffect(() => {
    let live = true;
    void api.get().then((s) => live && setState(s));
    return () => {
      live = false;
    };
  }, [api]);

  const save = (key: string | null) => {
    setRecording(false);
    void api.set(key).then(setState);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (!recording) return;
    e.preventDefault();
    if (e.key === "Escape" && bareKey(e)) return setRecording(false);
    if ((e.key === "Backspace" || e.key === "Delete") && bareKey(e)) return save(null);
    const key = acceleratorOf(e.nativeEvent);
    if (key) save(key);
  };

  const words = recording ? "Press the keys" : state?.key ? acceleratorHint(state.key) : "Off";
  return (
    <PageRow
      title="Capture key"
      description={recording ? "Escape to keep it, Delete to turn it off" : "Opens capture over any app"}
      error={!recording && state?.error ? state.error : undefined}
    >
      <Button
        variant="secondary"
        size="sm"
        disabled={!state}
        aria-pressed={recording}
        onClick={() => setRecording((r) => !r)}
        onKeyDown={onKeyDown}
        onBlur={() => setRecording(false)}
        className="min-w-28 tabular-nums"
      >
        {words}
      </Button>
    </PageRow>
  );
}
