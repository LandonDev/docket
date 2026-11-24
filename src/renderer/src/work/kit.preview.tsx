// What preview pages share to draw a state a static render cannot reach by props alone: a dialog or menu drawn in a
// portal, a control pressed as his click would, words typed into a field, and a host that answers from fixtures.
// Rendered by nothing in the app; imported only by *.preview.tsx files.
import { useEffect, useRef, type ReactNode } from "react";
import { registry, type Link } from "../lib/connection";

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
      <div ref={into} data-portal-copy aria-hidden style={{ position: "absolute", inset: 0, height, transform: "translateZ(0)", pointerEvents: "none" }} />
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
