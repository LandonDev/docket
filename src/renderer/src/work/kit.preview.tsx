// What preview pages share to draw a state a static render cannot reach by props alone: a dialog or menu drawn in a
// portal, a control pressed as his click would, words typed into a field, and a host that answers from fixtures.
// Rendered by nothing in the app; imported only by *.preview.tsx files.
import { useEffect, useRef, type ReactNode } from "react";
import type { CanvasItem, CanvasKind, SectorKey } from "@shared/work";
import { defineChunk } from "../lib/lazyChunk";
import { CanvasSeat } from "./canvas/CanvasSeat";
import type { CanvasBodyProps, CanvasKindDef } from "./canvas/kind";
import { CANVAS } from "./canvas/registry";
import { applyCanvasPush } from "./canvas/store";
import type { Capability } from "@shared/capabilities";
import { registry, type Link } from "../lib/connection";
import { workspaceStore } from "../lib/tcserver/workspaces";
import { setWorkOn } from "../lib/workSwitch";
import { ViewFrame } from "./shell/WorkViewPage";
import { FakeConvex, fakeSession } from "./today/fakeLifeos";
import { WORK_VIEWS, type WorkViewId } from "./views/registry";

// jsdom runs no animations, and lacks the call that lists them (Base UI asks it as a popup settles).
if (typeof Element !== "undefined" && !("getAnimations" in Element.prototype)) Object.assign(Element.prototype, { getAnimations: () => [] });

/**
 * A portal (a dialog, a menu) draws outside what a static render keeps: its copy is kept here as it settles. The box
 * is a containing block (a transform), so a dialog's fixed scrim and centred panel sit inside it at `height`; a
 * menu, whose floating place jsdom cannot measure, is set at `place` from the box's top corner.
 */
export function PortalCopy({ height, place }: { height: number; place?: { top: number; right?: number; left?: number } }) {
  const into = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const box = into.current;
    if (!box) return;
    const copy = (): void => {
      box.replaceChildren(...[...document.body.children].filter((el) => !el.contains(box)).map((el) => el.cloneNode(true)));
      const menu = box.querySelector<HTMLElement>("[role=menu]")?.parentElement;
      if (menu && place) menu.setAttribute("style", `position:absolute;top:${place.top}px;${place.left !== undefined ? `left:${place.left}px` : `right:${place.right ?? 0}px`};z-index:50`);
      for (const row of box.querySelectorAll("[data-highlighted]")) row.removeAttribute("data-highlighted");
      // jsdom never ends an entrance: a copy caught "starting" would be drawn half see-through.
      for (const el of box.querySelectorAll("[data-starting-style], [data-ending-style]")) {
        el.removeAttribute("data-starting-style");
        el.removeAttribute("data-ending-style");
      }
    };
    const watch = new MutationObserver((changes) => {
      if (changes.some((c) => !box.contains(c.target))) copy();
    });
    watch.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
    copy();
    return () => watch.disconnect();
  }, [place]);
  // A shot is taken once the page loads: an entrance caught half way would be drawn see-through, so the copy has none.
  return (
    <>
      <style>{"[data-portal-copy] *, [data-portal-copy] *::before { transition: none !important; animation: none !important; }"}</style>
      <div ref={into} data-portal-copy aria-hidden style={{ position: "absolute", inset: 0, zIndex: 100, height, transform: "translateZ(0)", pointerEvents: "none" }} />
    </>
  );
}

/** A frame for a surface with a portal over it: the surface, and the portal's copy laid over it at the same size. */
export function OverFrame({ height, maxWidth, place, children }: { height: number; maxWidth: number; place?: { top: number; right?: number; left?: number }; children: ReactNode }) {
  return (
    <div className="relative w-full overflow-hidden rounded-lg border border-border bg-background" style={{ maxWidth, height }}>
      {children}
      <PortalCopy height={height} place={place} />
    </div>
  );
}

/** Presses the first element `selector` finds once the page has painted, as his click would. */
export function usePress(selector: string | null, after = 40): void {
  useEffect(() => {
    if (!selector) return;
    const t = setTimeout(() => document.querySelector<HTMLElement>(selector)?.click(), after);
    return () => clearTimeout(t);
  }, [selector, after]);
}

/** Presses the first button whose words are `name` once the page has painted, as his click would. */
export function usePressNamed(name: string | null, after = 40): void {
  useEffect(() => {
    if (!name) return;
    const t = setTimeout(() => [...document.querySelectorAll<HTMLElement>("button")].find((b) => b.textContent?.trim() === name)?.click(), after);
    return () => clearTimeout(t);
  }, [name, after]);
}

/** Types `text` into the first field `selector` finds once the page has painted, as his keys would. */
export function useTyped(selector: string | null, text: string, after = 40): void {
  useEffect(() => {
    if (!selector) return;
    const t = setTimeout(() => {
      const field = document.querySelector<HTMLInputElement>(selector);
      if (!field) return;
      // The document's own window: a static render's globals may be the runtime's, not the document's.
      const view = field.ownerDocument.defaultView!;
      Object.getOwnPropertyDescriptor(view.HTMLInputElement.prototype, "value")?.set?.call(field, text);
      field.dispatchEvent(new view.Event("input", { bubbles: true }));
    }, after);
    return () => clearTimeout(t);
  }, [selector, text, after]);
}

/**
 * Every link of the window as one host that answers from `answer` (a method it does not know is refused), with
 * `environmentId` as its name. Returns the link, so a store can be attached to it.
 */
export function answerAs(answer: (method: string, params: Record<string, unknown>) => unknown, environmentId = "local"): Link {
  const link = {
    environmentId,
    profile: environmentId,
    connected: true,
    onOpen: () => () => {},
    onClose: () => () => {},
    onPush: () => () => {},
    onStatus: () => () => {},
    request<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
      try {
        return Promise.resolve(answer(method, params) as T);
      } catch (err) {
        return Promise.reject(err);
      }
    },
  } as unknown as Link;
  Object.assign(registry, { primary: () => link, linkOf: () => link, link: () => link });
  return link;
}

/** The made-up job every view preview stands in: Purdue Esports on this computer. */
export const JOB = { id: "ws", name: "Purdue Esports", path: "/home/work/Purdue Esports", kind: "work", sector: "purdue" as SectorKey, createdAt: 1, environmentId: "local" };

/**
 * A Work view's whole page as the column opens it (shell/WorkViewPage.tsx `ViewFrame`: its 40px header with the
 * view's own controls, its body), over a LifeOS that answers from `lifeos` and a host that answers from `host`
 * (the workspace list is answered here). Its chunk is loaded before the first render. Returns the fake LifeOS, so
 * a page can feed it more.
 */
export function standUpView(view: WorkViewId, lifeos: Record<string, unknown | ((args: Record<string, unknown>) => unknown)>, host: (method: string, params: Record<string, unknown>) => unknown = () => undefined): FakeConvex {
  void WORK_VIEWS[view].chunk.load();
  const link = answerAs((method, params) => {
    if (method === "workspace.list") return [JOB];
    if (method === "project.list") return [];
    const got = host(method, params);
    if (got === undefined) throw new Error(`no ${method}`);
    return got;
  });
  workspaceStore.reset();
  workspaceStore.attach(link);
  setWorkOn("local", true);
  const convex = new FakeConvex();
  for (const [name, value] of Object.entries(lifeos)) convex.answer(name, value);
  fakeSession("local", convex, JOB.sector);
  return convex;
}

/** The page `standUpView` stood up, in a frame as wide as the page up to `maxWidth`, with any dialog copied over it. */
export function ViewAt({ view, height = 640, maxWidth = 864 }: { view: WorkViewId; height?: number; maxWidth?: number }) {
  return (
    <div className="relative w-full overflow-hidden rounded-lg border border-border bg-background" style={{ maxWidth, height }}>
      <ViewFrame view={view} environmentId="local" workspaceId={JOB.id} sector={JOB.sector} />
      <PortalCopy height={height} />
    </div>
  );
}

/**
 * The window as a computer the host gave a key (docs/agents/pc-setup.md: operate, approve and device, no admin), on
 * every link: the seam `linkMay` reads (the link's last hello), as lib/linkMay.testkit.ts gives a DOM test. The host
 * is named `host`, so "Changed from a computer that manages …" names it.
 */
export function asGivenComputer(host = "The box", caps: readonly Capability[] = ["operate", "approve", "device"]): void {
  const statuses = new Map<string, ReturnType<typeof registry.statusOf>>();
  const statusOf = (id: string): ReturnType<typeof registry.statusOf> => {
    let status = statuses.get(id);
    if (!status) statuses.set(id, (status = { ...REAL_STATUS(id), transport: "open", lastHello: { caps, key: { id: "laptop" } } } as ReturnType<typeof registry.statusOf>));
    return status;
  };
  const all = new Map([["local", statusOf("local")]]);
  Object.assign(registry, { statusOf, statuses: () => all, environment: (id: string) => ({ ...(REAL_ENVIRONMENT(id) ?? {}), id, name: host }) });
}
const REAL_STATUS = registry.statusOf.bind(registry);
const REAL_ENVIRONMENT = registry.environment.bind(registry);

/**
 * One canvas item of `kind` open alone in the canvas pane (canvas/CanvasSeat.tsx), drawn by `parts` (the kind's Body
 * and Bar, given its host stand-in): the pane as wide as the page up to `maxWidth`, any dialog copied over it.
 */
export function CanvasKindAt({ id, kind, title, parts, height = 600, maxWidth = 864 }: { id: string; kind: CanvasKind; title: string; parts: { Body(props: CanvasBodyProps): ReactNode; Bar?(props: CanvasBodyProps): ReactNode }; height?: number; maxWidth?: number }) {
  const sessionId = `preview-${id}`;
  const item: CanvasItem = { id, sessionId, workspaceId: JOB.id, kind, title, source: { at: "thread" }, state: "open", position: 0, rev: 0, createdAt: 0, updatedAt: 0 };
  applyCanvasPush({ sessionId, items: [item], opened: id });
  const chunk = defineChunk(`preview-${kind}-${id}`, () => Promise.resolve(parts));
  void chunk.load();
  const kinds = { ...CANVAS, [kind]: { ...CANVAS[kind], chunk } } as Record<CanvasKind, CanvasKindDef>;
  return (
    <div className="relative flex w-full overflow-hidden rounded-lg border border-border bg-background" style={{ maxWidth, height }}>
      <CanvasSeat session={{ id: sessionId, environmentId: "local" }} kinds={kinds}>
        <div />
      </CanvasSeat>
      <PortalCopy height={height} />
    </div>
  );
}
