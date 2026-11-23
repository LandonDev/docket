import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { createRoot } from "react-dom/client";
import type { ShowDeck } from "@shared/contract-work-slides";
import type { ShowMode } from "@shared/slidesShow";
import { TooltipContainerProvider } from "../../../components/ui/tooltip";
import { pdfjsEngine, type PdfDoc, type PdfEngine } from "../../pdf/engine";
import { Audience } from "./Audience";
import { RENDER_CHANGED } from "../deck";
import { openFramePlace, openWindowPlace, type ShowPlace, type Surface } from "./places";
import { Presenter } from "./Presenter";
import { keyAct, NOTES_DEFAULT, NOTES_SIZES, showReducer, startShowState, stepNotes, type ShowAct, type ShowState } from "./state";
import { pauseTimer, restartTimer, resumeTimer, startTimer, TARGETS, type Target } from "./timer";

/**
 * A show, running (docs/agents/work-slides.md "The show"): the file's
 * slides read from the deck's host, one state, and the surfaces it is drawn
 * on, each in a document of its own (places.ts). It lives in a React root
 * of its own, apart from the canvas, so a talk goes on whatever the main
 * window shows meanwhile; it ends on Escape, on End, when its window is
 * closed, or when a new show starts.
 */

/** The deck's host, as a show uses it. */
export interface ShowHost {
  show(): Promise<ShowDeck>;
  /** Bytes of the file's render at `rev`; rejects with `RENDER_CHANGED` when the file moved on. */
  read(offset: number, length: number, rev: string): Promise<Uint8Array>;
  /** Hears the file's revision whenever the deck is told again; the show reads again when it is not the one it drew. */
  onRev(listener: (rev: string) => void): () => void;
}

export type { ShowMode } from "@shared/slidesShow";

/** Main's side of a show's windows (the preload's `tcShow`); absent in a browser. */
export type ShowNative = NonNullable<Window["tcShow"]>;

export interface ShowAsk {
  host: ShowHost;
  /** the deck's name: the windows' titles */
  title: string;
  /** the first slide, or the slide (by id) he is on */
  from: "start" | number;
  mode: ShowMode;
  /** the display the slideshow fills, where there is a choice */
  display?: number;
  engine?: PdfEngine;
  /** a test's: main's side, or null for a browser */
  native?: ShowNative | null;
  /** a test's: the places, in the stead of windows */
  open?(surface: Surface): ShowPlace | null;
  now?: () => number;
}

export interface ShowHandle {
  end(): void;
  /** settles when the show is over */
  done: Promise<void>;
}

const TARGET_KEY = "tc.show.target";
const NOTES_KEY = "tc.show.notes";
function kept<T>(key: string, read: (raw: string) => T | undefined, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return (raw === null ? undefined : read(raw)) ?? fallback;
  } catch {
    return fallback;
  }
}
function keep(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* a browser with storage off: the choice lasts the show */
  }
}

/** The show running in this window, if one is: a new one ends it. */
let running: ShowHandle | null = null;
/** A show being started (its windows are being asked for): a second press meanwhile is the same start. */
let starting: Promise<ShowHandle> | null = null;
export const showRunning = (): boolean => running !== null;

/**
 * Starts a show. In a browser the slideshow's full screen is asked for
 * before anything is awaited, in the press that called this. A press while
 * a start is under way (a double press, F5 twice) is that same start.
 */
export function startShow(ask: ShowAsk): Promise<ShowHandle> {
  if (starting) return starting;
  const start = begin(ask).finally(() => {
    if (starting === start) starting = null;
  });
  starting = start;
  return start;
}

async function begin(ask: ShowAsk): Promise<ShowHandle> {
  // The show before this one is over, in main too, before this one asks for its windows.
  if (running) {
    const was = running;
    was.end();
    await was.done;
  }
  const native = ask.native === undefined ? (window.tcShow ?? null) : ask.native;
  const places: ShowPlace[] = [];
  const take = (place: ShowPlace | null): void => void (place && places.push(place));
  if (ask.open) {
    if (native) await native.begin({ mode: ask.mode, ...(ask.display !== undefined ? { display: ask.display } : {}) });
    take(ask.mode === "presenter" ? null : ask.open("audience"));
    take(ask.mode === "full" ? null : ask.open("presenter"));
  } else if (native) {
    const frames = await native.begin({ mode: ask.mode, ...(ask.display !== undefined ? { display: ask.display } : {}) });
    if (frames.audience) take(openWindowPlace("audience", frames.audience, ask.title));
    if (frames.presenter) take(openWindowPlace("presenter", frames.presenter, `Presenter view: ${ask.title}`));
  } else {
    take(ask.mode === "presenter" ? openFramePlace("presenter", false) : openFramePlace("audience", true));
  }
  if (places.length === 0) {
    void native?.end();
    throw new Error("The show's window did not open");
  }
  let over = false;
  let settle = (): void => undefined;
  const done = new Promise<void>((resolve) => (settle = resolve));
  const handle: ShowHandle = {
    done,
    end() {
      if (over) return;
      over = true;
      if (running === handle) running = null;
      // Main hears at once, before any show that starts next asks for its windows.
      void native?.end();
      // Not inside a render of the root it unmounts.
      queueMicrotask(() => {
        root.unmount();
        for (const place of places) place.close();
        settle();
      });
    },
  };
  // A fault while drawing must not leave two empty windows up with the display held awake.
  const root = createRoot(document.createElement("div"), { onUncaughtError: () => handle.end() });
  running = handle;
  // The page going (a reload, the window closing) takes the show's windows with it.
  const leave = (): void => handle.end();
  window.addEventListener("pagehide", leave);
  void done.then(() => window.removeEventListener("pagehide", leave));
  root.render(<ShowRoot ask={ask} places={places} native={native} onOver={handle.end} />);
  return handle;
}

/** How long after a read of the deck failed the show asks again: 2 s, then twice as long each time, to 30 s. */
export const RETRY_FIRST_MS = 2000;
export const RETRY_MOST_MS = 30_000;

/** A press of Return or Space on a control is that control's own (End show, Pause, a menu's row): the show takes it only from the slide. */
function controlsKey(event: KeyboardEvent): boolean {
  if (event.key !== "Enter" && event.key !== " ") return false;
  const target = event.target as Element | null;
  return !!target?.closest?.('button, a[href], input, textarea, select, [role="button"], [role="option"], [role="menuitemradio"]');
}

const ratioOf = (place: ShowPlace): number => (place.win.devicePixelRatio || 1) / (window.devicePixelRatio || 1);

function ShowRoot({ ask, places: opened, native, onOver }: { ask: ShowAsk; places: ShowPlace[]; native: ShowNative | null; onOver(): void }) {
  const { host, engine = pdfjsEngine, now = Date.now } = ask;
  const [places, setPlaces] = useState(opened);
  const [state, setState] = useState<ShowState | null>(null);
  const [doc, setDoc] = useState<PdfDoc | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** a read of the deck failed while one is already up */
  const [lost, setLost] = useState(false);
  const [timer, setTimer] = useState(() => startTimer(now()));
  const [target, setTarget] = useState<Target>(() => kept(TARGET_KEY, (raw) => (raw === "none" ? null : TARGETS.find((t) => String(t) === raw)), null));
  const live = useRef<ShowState | null>(null);
  live.current = state;
  const [notesSize, setNotesSize] = useState(() => kept(NOTES_KEY, (raw) => (NOTES_SIZES[Number(raw)] ? Number(raw) : undefined), NOTES_DEFAULT));

  // Before the deck is read there is nothing to step; Escape and End still end the show.
  const dispatch = useCallback(
    (act: ShowAct) => {
      if (!live.current && (act.t === "escape" || act.t === "end")) return onOver();
      setState((was) => (was ? showReducer(was, act) : was));
    },
    [onOver],
  );

  // The deck, and again whenever its file changes. A render that replaces another is handed to the pictures at once
  // and the one before is let go: what is on screen stays until the new one has painted (pictures.tsx), so a save
  // mid-talk never blanks the room's screen, and the place is kept by the slide's id. A read that fails is asked
  // again, sooner at first; the deck already up stays up meanwhile, and the presenter's view says so.
  const held = useRef<PdfDoc | null>(null);
  const drawn = useRef<string | null>(null);
  const loads = useRef(0);
  const retry = useRef<{ timer: ReturnType<typeof setTimeout> | undefined; wait: number }>({ timer: undefined, wait: RETRY_FIRST_MS });
  const load = useCallback(async (): Promise<void> => {
    const mine = ++loads.current;
    clearTimeout(retry.current.timer);
    try {
      const deck = await host.show();
      if (mine !== loads.current) return;
      const render = deck.render;
      const opened = render ? await engine.open({ size: render.size, read: (offset, length) => host.read(offset, length, render.rev), onFail: () => void (mine === loads.current && void load()) }) : null;
      if (mine !== loads.current) return void opened?.destroy();
      held.current?.destroy();
      held.current = opened;
      drawn.current = deck.rev;
      retry.current.wait = RETRY_FIRST_MS;
      setDoc(opened);
      setError(deck.renderError ?? null);
      setLost(false);
      setState((was) => (was ? showReducer(was, { t: "deck", slides: deck.slides }) : startShowState(deck.slides, ask.from)));
    } catch (e) {
      if (mine !== loads.current) return;
      const message = e instanceof Error && e.message ? e.message : "The host did not answer";
      // The file moved on while it was read: read it as it is now, at once.
      if (message === RENDER_CHANGED) return void load();
      if (held.current) setLost(true);
      else setError(message);
      const wait = retry.current.wait;
      retry.current.wait = Math.min(RETRY_MOST_MS, wait * 2);
      retry.current.timer = setTimeout(() => void load(), wait);
    }
  }, [host, engine, ask.from]);
  useEffect(() => {
    void load();
    const off = host.onRev((rev) => void (rev !== drawn.current && void load()));
    const waiting = retry.current;
    return () => {
      off();
      loads.current++;
      clearTimeout(waiting.timer);
      held.current?.destroy();
      held.current = null;
    };
  }, [host, load]);

  const closed = state?.closed ?? false;
  useEffect(() => {
    if (closed) onOver();
  }, [closed, onOver]);

  // A window he closed ends the show. The slideshow's display leaving closes that window alone: the presenter's view goes on.
  const displayGone = useRef(false);
  useEffect(() => {
    const offs = places.map((place) =>
      place.onGone(() => {
        if (place.surface === "audience" && displayGone.current && places.some((p) => p.surface === "presenter")) return;
        onOver();
      }),
    );
    return () => offs.forEach((off) => off());
  }, [places, onOver]);
  useEffect(
    () =>
      native?.onDisplayGone(() => {
        const audience = places.find((p) => p.surface === "audience");
        if (!audience) return;
        if (!places.some((p) => p.surface === "presenter")) return onOver();
        displayGone.current = true;
        audience.close();
        setPlaces((was) => was.filter((p) => p !== audience));
        setNotice("The slideshow's display was disconnected");
      }),
    [native, places, onOver],
  );

  const changeNotes = useCallback((by: 1 | -1) => {
    setNotesSize((was) => {
      const next = stepNotes(was, by);
      keep(NOTES_KEY, String(next));
      return next;
    });
  }, []);

  // One listener a document: every key a clicker sends reaches the one state, whichever window has the keyboard.
  useEffect(() => {
    const strip = places.find((p) => p.surface === "presenter")?.body.ownerDocument;
    const onKey = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || controlsKey(event)) return;
      const act = keyAct(event, live.current ?? { picker: false });
      if (!act) return;
      event.preventDefault();
      if (act.t === "swallow") return;
      if (act.t === "notes") return changeNotes(act.by);
      // With a presenter's view the picker is its strip: G typed in the slideshow's window would send the keyboard nowhere.
      if (act.t === "picker" && strip && event.currentTarget !== strip) return;
      dispatch(act);
    };
    const docs = [...new Set(places.map((place) => place.body.ownerDocument))];
    for (const d of docs) d.addEventListener("keydown", onKey);
    return () => docs.forEach((d) => d.removeEventListener("keydown", onKey));
  }, [places, dispatch, changeNotes]);

  // The keyboard goes to the presenter's view when there is one, else to the slideshow.
  useEffect(() => {
    const place = places.find((p) => p.surface === "presenter") ?? places[0];
    place?.body.querySelector<HTMLElement>("[data-show]")?.focus();
  }, [places]);

  // Each window's pixels a CSS pixel, read again when it is resized or dragged to a display of another scale.
  const [ratios, setRatios] = useState(() => new Map(places.map((p) => [p, ratioOf(p)])));
  useEffect(() => {
    let offs: Array<() => void> = [];
    const read = (): void => {
      offs.forEach((off) => off());
      offs = places.flatMap((p) => {
        const query = p.win.matchMedia?.(`(resolution: ${p.win.devicePixelRatio || 1}dppx)`);
        if (!query) return [];
        query.addEventListener("change", read);
        return [() => query.removeEventListener("change", read)];
      });
      setRatios(new Map(places.map((p) => [p, ratioOf(p)])));
    };
    read();
    for (const p of places) p.win.addEventListener("resize", read);
    return () => {
      offs.forEach((off) => off());
      places.forEach((p) => p.win.removeEventListener("resize", read));
    };
  }, [places]);

  const shown = state ?? startShowState([], "start");
  const audience = places.find((p) => p.surface === "audience");
  const presenter = places.find((p) => p.surface === "presenter");
  return (
    <>
      {audience ? createPortal(<Audience state={shown} dispatch={dispatch} doc={doc} error={error} ratio={ratios.get(audience) ?? 1} picks={!presenter} />, audience.body) : null}
      {presenter
        ? createPortal(
            <TooltipContainerProvider value={presenter.body}>
              <Presenter
                state={shown}
                dispatch={dispatch}
                doc={doc}
                loading={!state && !error}
                error={error}
                notice={notice ?? (lost ? "Reconnecting to the deck…" : null)}
                ratio={ratios.get(presenter) ?? 1}
                timer={timer}
                target={target}
                onTimer={(act) => setTimer((was) => (act === "pause" ? pauseTimer(was, now()) : act === "resume" ? resumeTimer(was, now()) : restartTimer(was, now())))}
                onTarget={(next) => {
                  setTarget(next);
                  keep(TARGET_KEY, next === null ? "none" : String(next));
                }}
                notesSize={notesSize}
                onNotesSize={changeNotes}
                now={now}
              />
            </TooltipContainerProvider>,
            presenter.body,
          )
        : null}
    </>
  );
}
