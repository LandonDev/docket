import { BONES } from "@renderer/lib/ease";

/*
 * Bones that are taken away whole (a `Bones` unmounted: a lazy surface's
 * fallback as its chunk lands) still give way to what follows them
 * (docs/agents/loading-bones.md "Bones unmounted whole"). The engine calls
 * `bridgeBones` as such bones unmount, while their node still stands; what
 * happens is decided once the commit has taken it away:
 *
 * - Bones stand where it stood (the fallback's giving way to the surface's
 *   own): nothing to do.
 * - Content arrived where it stood (an `Arrive` mounted by the same commit):
 *   Skullet's own reveal. The bones' node is put back beside the content as
 *   the pane on its way out, and the content comes in over it.
 * - Anything else took its place: a copy of the bones fades out over it, its
 *   bars still in the sweep.
 */

/** Skullet's reveal, handed in by the one file that imports it (bonesEngine.tsx). */
export type Reveal = {
  fadeIn: (element: HTMLElement) => Promise<void>;
  fadeOut: (element: HTMLElement, box?: Box) => Promise<void>;
  /** Content should land whole: motion is reduced, the window is hidden, or someone pressed a key or scrolled a moment ago. */
  still: () => boolean;
  /** The content's own fills settling under its pieces. */
  surfaces: (element: HTMLElement) => void;
};
type Box = { top: number; left: number; width: number; height: number };

/** The bars Skullet drew, layer by layer, each with the sweep it runs. */
type Bars = { bar: HTMLElement; sweep: AnimationEffect | null }[][];

/** Skullet draws its bars in a shadow root, which a clone does not carry: they are read while the bones still stand. */
const barsOf = (node: Element): Bars =>
  [...node.querySelectorAll("[skullet-layer]")].map((layer) =>
    ([...(layer.shadowRoot?.children ?? [])] as HTMLElement[]).map((bar) => ({ bar, sweep: bar.getAnimations?.()[0]?.effect ?? null })),
  );

/** A copy of some bones as they stood, their bars lifted out of the shadow root into the copy's own layers as plain children. */
function copyOf(node: Element, bars: Bars): HTMLElement {
  const copy = node.cloneNode(true) as HTMLElement;
  copy.querySelectorAll("[skullet-layer]").forEach((layer, at) => {
    layer.replaceChildren(...(bars[at] ?? []).map(({ bar }) => bar.cloneNode(true)));
  });
  return copy;
}

/** The copy's bars keep the sweep of the bars they stand for, in step, so nothing stops as the fade begins. */
function keepSweep(copy: HTMLElement, bars: Bars) {
  copy.querySelectorAll("[skullet-layer]").forEach((layer, at) => {
    [...layer.children].forEach((bar, index) => {
      const sweep = bars[at]?.[index]?.sweep;
      if (!(sweep instanceof KeyframeEffect)) {
        // No sweep to follow (motion reduced, or the browser dropped it): a plain bone.
        (bar as HTMLElement).style.backgroundImage = "none";
        return;
      }
      bar.animate(sweep.getKeyframes(), sweep.getTiming()).startTime = 0;
    });
  });
}

const overlaps = (a: DOMRect, b: DOMRect) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
/** Drawn at all: a tab parked behind the one on screen lies in the same box, unseen (`content-visibility: hidden`). */
const drawn = (element: Element) => element.checkVisibility?.() ?? true;
const within = (inner: DOMRect, outer: DOMRect) => inner.left >= outer.left - 2 && inner.top >= outer.top - 2 && inner.right <= outer.right + 2 && inner.bottom <= outer.bottom + 2;

/** What of `box` its scrollers and clips let through: the copy is laid over the window, where nothing else would cut it. */
function seenOf(node: Element, box: DOMRect): DOMRect {
  let { left, top, right, bottom } = box;
  for (let parent = node.parentElement; parent; parent = parent.parentElement) {
    const style = getComputedStyle(parent);
    if (style.overflowX === "visible" && style.overflowY === "visible") continue;
    const cut = parent.getBoundingClientRect();
    left = Math.max(left, cut.left);
    top = Math.max(top, cut.top);
    right = Math.min(right, cut.right);
    bottom = Math.min(bottom, cut.bottom);
  }
  return new DOMRect(left, top, Math.max(0, right - left), Math.max(0, bottom - top));
}

/** Where leaving bones are laid: one layer over the window, under every dialog and menu. */
function windowLayer(): HTMLElement {
  const held = document.querySelector<HTMLElement>("body > [data-bones-layer]");
  if (held) return held;
  const layer = document.createElement("div");
  layer.setAttribute("data-bones-layer", "");
  layer.setAttribute("aria-hidden", "true");
  layer.inert = true;
  document.body.append(layer);
  return layer;
}

export function bridgeBones(node: HTMLElement, reveal: Reveal, stood?: DOMRect | null) {
  // Where the bones were last seen (`stood`), not where they stand now: this is called as the commit takes them
  // away, and by then a region above may hold its leaving bones and its content both, in flow, for a moment.
  const box = stood ?? node.getBoundingClientRect();
  if (box.width === 0 || box.height === 0) return;
  const seen = seenOf(node, box);
  if (seen.width === 0 || seen.height === 0) return;
  const bars = barsOf(node);
  queueMicrotask(() => {
    // Bones that still stand (hidden for a moment, or mounted twice in development) need no bridge.
    if (node.isConnected) return;
    const standing = [...document.querySelectorAll('[data-bones="shown"]')].some((other) => drawn(other) && within(seen, other.getBoundingClientRect()));
    if (standing) return;

    const arrivals = [...document.querySelectorAll<HTMLElement>("[data-arrive]")].filter(
      (element) => !element.closest("[skullet-ghost]") && drawn(element) && overlaps(element.getBoundingClientRect(), seen),
    );
    if (reveal.still()) {
      // Every arrival stands at once, and no bones are put back to leave over them.
      for (const element of arrivals) element.removeAttribute("data-arrive");
      return;
    }
    const arrived = arrivals[0];
    const parent = arrived?.parentElement;
    let hole: DOMRect | null = null;
    if (arrived && parent) {
      // The bones go back in, out of flow where they stood, as the pane Skullet takes out.
      node.style.position = "absolute";
      node.setAttribute("data-bones", "leaving");
      parent.append(node);
      const anchor = (node.offsetParent as HTMLElement | null) ?? document.documentElement;
      const origin = anchor.getBoundingClientRect();
      const done = () => node.remove();
      // The content's own short fade gives way to the reveal.
      arrived.removeAttribute("data-arrive");
      void reveal
        .fadeOut(node, { top: box.top - origin.top - anchor.clientTop, left: box.left - origin.left - anchor.clientLeft, width: box.width, height: box.height })
        .then(done, done);
      // Once the content is in, the bones put back over it are gone.
      void reveal.fadeIn(arrived).then(done, done);
      reveal.surfaces(arrived);
      // Bones much larger than what arrived: the rest of them still gives way by the copy below, with a hole where the reveal runs.
      const where = arrived.getBoundingClientRect();
      if (where.width * where.height >= seen.width * seen.height * 0.8) return;
      hole = where;
    }

    const copy = copyOf(node, bars);
    // Still laid out as bones, no longer counted as bones.
    copy.setAttribute("data-bones", "copy");
    Object.assign(copy.style, {
      position: "absolute",
      left: `${box.left}px`,
      top: `${box.top}px`,
      width: `${box.width}px`,
      height: `${box.height}px`,
      margin: "0",
      overflow: "hidden",
    });
    const px = (value: number) => `${Math.round(value)}px`;
    const [l, t, r, b] = [seen.left - box.left, seen.top - box.top, seen.right - box.left, seen.bottom - box.top].map(px);
    const outer = `${l} ${t}, ${r} ${t}, ${r} ${b}, ${l} ${b}, ${l} ${t}`;
    if (hole) {
      const [x1, y1, x2, y2] = [hole.left - box.left, hole.top - box.top, hole.right - box.left, hole.bottom - box.top].map(px);
      copy.style.clipPath = `polygon(evenodd, ${outer}, ${x1} ${y1}, ${x2} ${y1}, ${x2} ${y2}, ${x1} ${y2}, ${x1} ${y1})`;
    } else if (seen.width < box.width || seen.height < box.height) {
      copy.style.clipPath = `polygon(${outer})`;
    }
    windowLayer().append(copy);
    keepSweep(copy, bars);
    const done = () => copy.remove();
    const fade = copy.animate(BONES.copyOut.keyframes, BONES.copyOut.timing);
    fade.finished.then(done, done);
    // A window that hides mid-fade draws no frame for it to end on.
    setTimeout(done, BONES.leaveCapMs);
  });
}
