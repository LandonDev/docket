import type { SoundName } from "cuelume";

/* The sound engine rides its own chunk: no cue plays before the first paint.
   Asked for at the first idle moment after launch, so a first cue finds it loaded. */
type Engine = typeof import("cuelume");
let engine: Promise<Engine> | undefined;
const loadEngine = (): Promise<Engine> => (engine ??= import("cuelume"));

const KEY = "docket.sounds";

export const SOUNDS_DEFAULT = true;

/** Soft enough to sit in the background while a turn runs in another app. */
export const SOUNDS_VOLUME = 0.55;

export const SOUNDS_CHANGE_EVENT = "docket:sounds-change";

export type SoundCue =
  | "turnFinished"
  | "updateAvailable"
  | "switch"
  | "copy";

const CUES: Record<SoundCue, SoundName> = {
  turnFinished: "success",
  updateAvailable: "arrival",
  switch: "toggle",
  copy: "scan",
};

export function loadSoundsEnabled(): boolean {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw == null) return SOUNDS_DEFAULT;
    return raw === "1" || raw === "true";
  } catch {
    return SOUNDS_DEFAULT;
  }
}

export function saveSoundsEnabled(value: boolean) {
  try {
    localStorage.setItem(KEY, value ? "1" : "0");
  } catch {
    // private mode / quota
  }
  // An engine not yet asked for reads the switch at its first cue.
  void engine?.then(applySoundEngine);
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<boolean>(SOUNDS_CHANGE_EVENT, { detail: value }),
  );
}

function applySoundEngine(lib: Engine) {
  lib.setEnabled(loadSoundsEnabled());
  lib.setVolume(SOUNDS_VOLUME);
}

/** Load the engine once the launch is idle, with the stored mute and volume. */
export function initSounds() {
  const warm = () => void loadEngine().then(applySoundEngine, () => {});
  if (typeof requestIdleCallback === "function") requestIdleCallback(warm, { timeout: 5000 });
  else setTimeout(warm, 2000);
}

export function playCue(cue: SoundCue) {
  if (!loadSoundsEnabled()) return;
  void loadEngine().then(
    (lib) => {
      // Read again: he may have switched sounds off while the chunk loaded.
      if (!loadSoundsEnabled()) return;
      applySoundEngine(lib);
      lib.play(CUES[cue]);
    },
    () => {
      // A chunk that failed to load is asked for again at the next cue.
      engine = undefined;
    },
  );
}

let announcedUpdate: string | undefined;

/** One cue per available version, including a later probe of the same build. */
export function announceUpdateAvailable(version: string | null) {
  if (!version) {
    announcedUpdate = undefined;
    return;
  }
  if (announcedUpdate === version) return;
  announcedUpdate = version;
  playCue("updateAvailable");
}

/** Test helper: forget which inbox/update cues already fired. */
export function resetSoundCues() {
  announcedUpdate = undefined;
}
