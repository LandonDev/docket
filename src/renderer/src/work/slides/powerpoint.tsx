import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { OfficeStatus } from "@shared/contract-work-office";
import type { DeckView } from "@shared/contract-work-slides";
import { effectsChanged } from "@shared/work/deckShow";
import type { CanvasSource } from "@shared/work";
import { Spinner } from "../../components/ui/spinner";
import { registry } from "../../lib/connection";
import { EmptyState } from "../../surfaces/SurfaceSkeleton";
import { sayError } from "../canvas/frame";
import type { InPowerPointAsk } from "./Present";

/**
 * A deck and the real PowerPoint (docs/agents/work-slides.md "PowerPoint"): whether desktop PowerPoint is on the
 * computer the deck's file is on (`work.office.status`), the tab row's switch that opens the deck there
 * (`work.office.switch`), what the canvas says while it is open there, and the Present menu's "In PowerPoint"
 * (`work.office.present`), offered only where that computer can (`check`).
 */

/**
 * This window's name for the computer a file is on, which is the one that opens it: the file's own host, else the
 * thread's. A file names its host by the host's own id, and the window may know that host by another name (its own
 * is "local", a browser's is "web"), so it is found by what each host said of itself. Null where this window has no
 * way to that computer: nothing of PowerPoint is offered for the deck then.
 */
export function hostOf(source: CanvasSource, env: string): string | null {
  const host = "host" in source && source.host ? source.host : env;
  if (host === env || registry.has(host)) return host;
  return registry.environments().find((e) => registry.statusOf(e.id).lastHello?.environmentId === host)?.id ?? null;
}
/** A request to one of the window's hosts. A name the window does not know is a rejection, never a throw: a throw in an effect takes the whole surface down. */
function request<T>(env: string, method: Parameters<ReturnType<typeof registry.linkOf>["request"]>[0], params: unknown): Promise<T> {
  try {
    return registry.linkOf(env).request<T>(method, params as never);
  } catch (e) {
    return Promise.reject(e instanceof Error ? e : new Error(String(e)));
  }
}
/** What a press says when the deck's computer cannot be reached from this window. */
const NO_ANSWER = "PowerPoint did not answer";

/** Whether desktop PowerPoint is installed on a host: read once a window, and again after a minute. */
const installed = new Map<string, { at: number; ask: Promise<boolean> }>();
const FRESH_MS = 60_000;
export function powerPointOn(env: string): Promise<boolean> {
  const had = installed.get(env);
  if (had && Date.now() - had.at < FRESH_MS) return had.ask;
  const ask = request<OfficeStatus>(env, "work.office.status", {})
    .then(
      (status) => status.apps.some((a) => a.app === "powerpoint" && a.installed),
      () => false,
    );
  installed.set(env, { at: Date.now(), ask });
  return ask;
}

/** True once the deck's computer is known to have PowerPoint; false until then, and where it has none. */
export function usePowerPointOn(source: CanvasSource, env: string, ask = true): boolean {
  const host = hostOf(source, env);
  const [on, setOn] = useState<{ host: string; on: boolean } | null>(null);
  useEffect(() => {
    if (!ask || host === null) return;
    let live = true;
    void powerPointOn(host).then((yes) => live && setOn({ host, on: yes }));
    return () => {
      live = false;
    };
  }, [host, ask]);
  return on?.host === host && on.on;
}

/** Whether "In PowerPoint" may be offered for a deck: asked of its computer, which opens nothing to answer; kept a minute. */
const presentable = new Map<string, { at: number; ask: Promise<boolean> }>();
function canPresentOn(host: string, key: string): Promise<boolean> {
  const had = presentable.get(`${host}\n${key}`);
  if (had && Date.now() - had.at < FRESH_MS) return had.ask;
  const ask = request<{ can: boolean }>(host, "work.office.present", { source: JSON.parse(key) as CanvasSource, check: true })
    .then(
      (got) => got.can === true,
      () => false,
    );
  presentable.set(`${host}\n${key}`, { at: Date.now(), ask });
  return ask;
}

export function usePresentable(source: CanvasSource, env: string, ask: boolean): boolean {
  const host = hostOf(source, env);
  const key = JSON.stringify(source);
  const [can, setCan] = useState<{ key: string; can: boolean } | null>(null);
  useEffect(() => {
    if (!ask || host === null) return;
    let live = true;
    void canPresentOn(host, key).then((yes) => live && setCan({ key, can: yes }));
    return () => {
      live = false;
    };
  }, [host, key, ask]);
  return can?.key === key && can.can;
}

/** The Present menu's "In PowerPoint" for a deck, where its computer can present it; null elsewhere. */
export function useInPowerPoint(view: DeckView | null, source: CanvasSource, env: string): InPowerPointAsk | null {
  const can = usePresentable(source, env, !!view);
  const changed = view ? effectsChanged(view.slides.filter((s) => s.from === "file")) : 0;
  return useMemo(
    () => (can ? { changed, present: () => void presentInPowerPoint(source, env).catch((e: unknown) => sayError(e, "Couldn't present in PowerPoint")) } : null),
    [can, changed, source, env],
  );
}

/** His press: the deck in PowerPoint on its own computer, and PowerPoint's own slideshow from the first slide. */
export function presentInPowerPoint(source: CanvasSource, env: string): Promise<unknown> {
  const host = hostOf(source, env);
  return host === null ? Promise.reject(new Error(NO_ANSWER)) : request<unknown>(host, "work.office.present", { source });
}

// ── the switch's state, one per item while the window lives ──

export type Opening = { state: "opening" } | { state: "open" } | { state: "failed"; error: string };
const opens = new Map<string, Opening>();
const heard = new Set<() => void>();
export const sayOpening = (itemId: string, next: Opening): void => {
  opens.set(itemId, next);
  for (const fn of heard) fn();
};
const subscribe = (fn: () => void): (() => void) => {
  heard.add(fn);
  return () => heard.delete(fn);
};
/** A test's: forget what was read of every host, and every switch's state. */
export function forgetPowerPoint(): void {
  installed.clear();
  presentable.clear();
  opens.clear();
}
export const useOpening = (itemId: string): Opening | undefined => useSyncExternalStore(subscribe, () => opens.get(itemId));

/** The switch's PowerPoint side: the deck opened in PowerPoint on its own computer. */
export function openInPowerPoint(itemId: string, source: CanvasSource, env: string): Promise<void> {
  sayOpening(itemId, { state: "opening" });
  const host = hostOf(source, env);
  return (host === null ? Promise.reject(new Error(NO_ANSWER)) : request<unknown>(host, "work.office.switch", { source })).then(
    () => sayOpening(itemId, { state: "open" }),
    (e: unknown) => sayOpening(itemId, { state: "failed", error: e instanceof Error && e.message ? e.message : NO_ANSWER }),
  );
}

/** The canvas while the deck is in PowerPoint: the bar says how many suggestions wait here, with Review. */
export function InPowerPoint({ itemId, onRetry }: { itemId: string; onRetry(): void }) {
  const opening = useOpening(itemId);
  if (opening?.state === "opening")
    return (
      <div data-in-powerpoint="opening" className="grid h-full place-items-center">
        <span className="flex items-center gap-2 text-[13px] leading-5 text-muted-foreground">
          <Spinner className="size-3.5" />
          Opening in PowerPoint…
        </span>
      </div>
    );
  if (opening?.state === "failed")
    return (
      <div data-in-powerpoint="failed" className="h-full">
        <EmptyState title="Couldn't open it in PowerPoint" line={opening.error} action={{ label: "Try again", onClick: onRetry }} />
      </div>
    );
  return (
    <div data-in-powerpoint="open" className="h-full">
      <EmptyState title="Open in PowerPoint" />
    </div>
  );
}
