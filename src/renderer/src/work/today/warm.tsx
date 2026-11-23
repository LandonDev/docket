import { Component, memo, useLayoutEffect, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useTodayEnv } from "./env";
import { dropSource, putAnswer, resetHooks, useTodayState } from "./store";
import type { TodayEnv, TodaySource } from "./types";

/**
 * Today kept warm (docs/agents/work-today.md "Speed"). The sources are
 * hooks, so something must be mounted for them to run: while the page is
 * open it runs them itself (`SourceRuns`); for ten minutes after it closes,
 * and from its rail row's hover or focus, a root of their own does, in no
 * document. Their LifeOS session and their live queries stay up for that
 * time, so the next open paints rows that are already current.
 */

/** How long the sources run on after the page closes, or after a hover warmed them. */
export const KEEP_MS = 10 * 60_000;

/** One source, run as a hook of its own component, so one that throws takes only itself out. */
const SourceRun = memo(function SourceRun({ source, env }: { source: TodaySource; env: TodayEnv }) {
  // `use` is a hook under a method's name: the compiler must not cache the call as a plain one.
  "use no memo";
  const answer = source.use(env);
  // Before paint: the rows a source has at mount are in the first frame.
  useLayoutEffect(() => putAnswer(source.id, answer), [source.id, answer]);
  return null;
});

class SourceBoundary extends Component<{ id: string; children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }
  override componentDidCatch(error: unknown): void {
    dropSource(this.props.id, error);
  }
  override render(): ReactNode {
    return this.state.failed ? null : this.props.children;
  }
}

/** Every loaded source, each run on its own against `env`. */
export function SourceRuns({ env }: { env: TodayEnv }) {
  const { sources } = useTodayState();
  return sources.map(({ id, source }) => (
    <SourceBoundary key={id} id={id}>
      <SourceRun source={source} env={env} />
    </SourceBoundary>
  ));
}

/** The sources with an env of their own, for the root that keeps them warm. */
function Keeper() {
  const { env } = useTodayEnv();
  return <SourceRuns env={env} />;
}

let root: Root | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let open = false;
let allowed = true;
/** Whether the sources should run in a root of their own now; the root follows a moment later. */
let wanted = false;
let settling = false;

/**
 * The root follows `wanted`, never inside React's own render or commit: the
 * page says it opened or closed from an effect, and a root may not be made
 * or unmounted while React is at work.
 */
function settle(): void {
  if (settling) return;
  settling = true;
  queueMicrotask(() => {
    settling = false;
    if (wanted && !root) {
      root = createRoot(document.createElement("div"));
      root.render(<Keeper />);
    } else if (!wanted && root) {
      root.unmount();
      root = null;
    }
  });
}

function stop(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  wanted = false;
  settle();
}

/** Run the sources for a while with no page: from the row's hover or focus, the idle warm, and the page's close. Nothing while the page is open, which runs them itself. */
export function keepWarm(ms = KEEP_MS): void {
  if (open || !allowed || typeof document === "undefined") return;
  wanted = true;
  settle();
  if (timer) clearTimeout(timer);
  timer = setTimeout(stop, ms);
}

/** The page is on screen and runs the sources itself; closed, they run on for ten minutes. */
export function pageOpen(now: boolean): void {
  open = now;
  if (now) stop();
  else keepWarm();
}

/** Whether the sources run, or are about to, in a root of their own. */
export const keepingWarm = (): boolean => wanted;

/** Test seam: stops the keeper, and says whether one may start (a test that renders the page wants none after it). */
export function setWarmAllowed(next: boolean): void {
  allowed = next;
  open = false;
  if (timer) clearTimeout(timer);
  timer = null;
  wanted = false;
  // At once: a test's next step must not find the last one's root still running.
  root?.unmount();
  root = null;
}

// A reset (a test, a preview) stops the keeper and allows none until a test asks for one.
resetHooks.add(() => setWarmAllowed(false));

// ── the habit ──────────────────────────────────────────────────────────────

const OPENED_KEY = "work.today.opened.v1";
const dayOf = (at: number): string => {
  const d = new Date(at);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const daysBefore = (at: number, days: number): number => {
  const d = new Date(at);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - days).getTime();
};

function openedDays(): string[] {
  try {
    const parsed = JSON.parse(globalThis.localStorage?.getItem(OPENED_KEY) ?? "[]") as unknown;
    return Array.isArray(parsed) ? parsed.filter((day): day is string => typeof day === "string").slice(0, 2) : [];
  } catch {
    return [];
  }
}

/** He opened Today: the day is kept, with the one before it. Two dates, nothing else. */
export function noteOpened(now = Date.now()): void {
  const today = dayOf(now);
  const days = [today, ...openedDays().filter((day) => day !== today)].slice(0, 2);
  try {
    globalThis.localStorage?.setItem(OPENED_KEY, JSON.stringify(days));
  } catch {
    // private mode / quota
  }
}

/** Whether he opened Today today or on either of the two days before: then it is worth reading at idle after launch. */
export function openedLately(now = Date.now()): boolean {
  const lately = new Set([0, 1, 2].map((days) => dayOf(daysBefore(now, days))));
  return openedDays().some((day) => lately.has(day));
}
