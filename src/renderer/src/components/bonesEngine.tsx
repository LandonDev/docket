import { Component, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { instant, together, type RevealSpec } from "skullet";
import { boxOf, fadeIn, fadeOut, Ghost, INLINE_SCRIPT, Memory, shimmer, type PaneBox } from "skullet/internal";
import { BONES } from "@renderer/lib/ease";
import { reducedMotion } from "@renderer/lib/motion";
import { InBones, InRegion, regionClass, type RegionProps } from "./bones";
import { bridgeBones } from "./bonesBridge";

/*
 * The one file that imports Skullet (docs/agents/loading-bones.md;
 * lib/bonesGuard.test.ts). It rides a chunk of its own, asked for by
 * components/bones.tsx, which is what app code imports.
 *
 * The bones, their sweep, the memory of a shown shape and the reveal are
 * Skullet's (`Ghost`, `fadeIn`, `fadeOut`, `Memory`). Ours, and narrow:
 *
 * 1. The panes are our own two (`Region`): Skullet's `<Skeleton>` keeps its
 *    memory watching the content and reads the whole of a live list again
 *    250 ms after every change to it, and here every list is live. A region
 *    with an `id` hands its content to that memory once, after it has
 *    arrived (`remember`).
 * 2. A bone with no row of the content landing on it leaves by its own place
 *    in the window (`byPlace`), where Skullet sends it out at once: bones
 *    drawn from a sample rarely have the content's very rows.
 * 3. The content's own fills come in under its pieces (`BONES.surfaces`),
 *    where Skullet stands them at once.
 * 4. A region's first bones wait 150 ms before they show, and are measured
 *    only then: most reads here answer sooner, and such a read costs the
 *    sample's layout and nothing more.
 * 5. Bones unmounted whole still give way (bonesBridge.ts), and no bone
 *    outlives its text (`sweepBones`).
 * 6. Nothing waits on a frame: a hidden window lands content at once, and a
 *    leaving pane is dropped after `BONES.leaveCapMs` whatever its fade says.
 */

/** True once anything has loaded: from then on every wait is counted from its own start. */
let settled = false;

/** Bones on screen: their hold is over. */
const SHOWN = '[data-bones="shown"]';
/** When bones last left the screen: new bones inside `BONES.followsMs` of that follow them. */
let bonesLeftAt = -Infinity;

/** When a key was last pressed or the page last scrolled: content that lands just after lands at once (Skullet's own rule for its pieces). */
let lastInput = -Infinity;
if (typeof addEventListener !== "undefined") {
  for (const type of ["wheel", "touchmove", "keydown"]) addEventListener(type, () => (lastInput = performance.now()), { passive: true, capture: true });
}

/** Content should land whole: the window draws no frames, motion is reduced, or someone pressed a key or scrolled a moment ago. */
const still = () => document.hidden || reducedMotion() || performance.now() - lastInput < BONES.inputMs;

/** Bones that are drawn: a tab parked behind the one on screen keeps its bones in the page (`content-visibility: hidden`), and they are no one's to follow. */
const drawn = (element: Element) => element.checkVisibility?.() ?? true;
const bonesStand = () => [...document.querySelectorAll(SHOWN)].some(drawn);

/** Bones stand now, or left a moment ago: what mounts in their place follows them. */
export const bonesFollow = () => !document.hidden && (performance.now() - bonesLeftAt < BONES.followsMs || bonesStand());

/**
 * When a piece of a reveal moves: a row of content arrives whole, by where its row stands in the
 * window; a bone leaves with the row that lands on it, or else by where it stands itself. Off
 * screen, at once.
 */
const byPlace = ({ rect, unit, secondary, late }: { rect: DOMRect; unit: DOMRect | null; secondary: boolean; late: number }) => {
  const box = unit ?? rect;
  if (box.bottom <= 0 || box.top >= innerHeight) return null;
  const at = Math.min(Math.max(box.top / innerHeight, 0), 1) * BONES.spreadMs;
  return Math.max(at - late, 0) + (secondary ? BONES.secondaryMs : 0);
};

/**
 * How content replaces its bones: Skullet's `smart`, with `byPlace` for its order. At once when it
 * should land whole; one fade for a small part; row by row for the rest.
 */
const REVEAL: RevealSpec = {
  hold: BONES.holdMs,
  choose: (context) => (context.input || still() ? instant : context.height < 72 || context.pieces <= 3 ? together : { order: byPlace }),
};

/**
 * What is left of the hold as bones mount. Bones that follow bones (some stand now, or left a
 * moment ago: a fallback's giving way to its surface's own) take their place at once, so a
 * skeleton never gives way to a blank and then to another skeleton. The first bones of a launch
 * have been waited for since the window began, so the wait counts from there; after that, from now.
 */
function holdLeft(hold: number) {
  if (hold <= 0 || bonesFollow()) return 0;
  return settled ? hold : Math.max(0, hold - performance.now());
}

/**
 * Marks what is unseen at rest in a drawing (a control that shows on hover, a slot kept for an unset field), so
 * Skullet draws no bone for it. It names nothing outside itself: a still page with no engine in it runs it from its
 * own source (`previewScript`).
 */
function markUnseen(root: HTMLElement) {
  // Empty elements that stand for a line of text in Skullet's eyes; here they are spacers and unset slots.
  const textTags = "a,b,code,dd,dt,em,h1,h2,h3,h4,h5,h6,i,label,li,p,small,span,strong,td,th,time";
  const clear = (color: string) => !color || color === "transparent" || /[,/]\s*0\)$/.test(color);
  const none = (value: string) => !value || value === "none";
  const filled = (style: CSSStyleDeclaration) => !clear(style.backgroundColor) || !none(style.backgroundImage) || !none(style.boxShadow);
  const paints = (style: CSSStyleDeclaration) => filled(style) || (!none(style.borderTopStyle) && style.borderTopWidth !== "0px");
  const sides = ["Top", "Right", "Bottom", "Left"] as const;
  for (const element of root.querySelectorAll<HTMLElement>("*")) {
    if (element.closest("svg, [skullet-ignore]") || element.hasAttribute("skullet-block")) continue;
    const style = getComputedStyle(element);
    const unseen = style.opacity === "0" || element.classList.contains("invisible");
    const hollow = !element.firstChild && element.matches(textTags) && !paints(style);
    if (unseen || hollow) {
      element.setAttribute("skullet-ignore", "");
      continue;
    }
    // A clear border all round is room kept for a state (every `Item` row has one), and Skullet takes any border
    // all round for a painted box: a row with one name would be one block. Its top edge gives its width to the
    // padding, so the box keeps its size and reads as the plain row it is.
    const bordered = sides.every((side) => !none(style[`border${side}Style`]) && style[`border${side}Width`] !== "0px");
    if (bordered && !filled(style) && sides.every((side) => clear(style[`border${side}Color`]))) {
      element.style.paddingTop = `${parseFloat(style.paddingTop) + parseFloat(style.borderTopWidth)}px`;
      element.style.borderTopStyle = "none";
    }
  }
}

/**
 * For a still page with no engine in it (scripts/ui-preview.ts): a script that measures the drawing it follows and
 * draws its bones, as Skullet's own server render does, after the same marking of what is unseen.
 */
export const previewScript = () => `(${markUnseen.toString()})(document.currentScript.previousElementSibling.firstElementChild);${INLINE_SCRIPT}`;

/** A drawing larger than this is not handed to Skullet's memory: reading it would cost more than it saves. */
const MOST_REMEMBERED = 6000;

/**
 * Hands a region's content to Skullet's memory, once: its next bones are then drawn from the shape
 * it last showed (its own groups, its own row counts), not from the sample. Skullet's memory
 * would go on watching the content; it is let go as soon as it has read it.
 */
function remember(content: HTMLElement, id: string) {
  if (!content.isConnected || content.querySelector("[skullet-loading]") || content.getElementsByTagName("*").length > MOST_REMEMBERED) return;
  markUnseen(content);
  const memory = new Memory(content, { id });
  // Letting go would read it a second time.
  memory.save = () => {};
  memory.destroy();
}

/**
 * The drawing the bones are measured from, in Skullet's own three boxes. Unseen from its first
 * commit (index.css brings Skullet's sheet), and measured once `measured`: until then it only
 * holds the room.
 */
function Drawing({ id, measured, inline, children }: { id?: string; measured: boolean; inline?: boolean; children: ReactNode }) {
  const root = useRef<HTMLDivElement & HTMLSpanElement>(null);
  const Box = inline ? "span" : "div";
  // Bones that have stood `BONES.sweepCapMs` go still (lib/ease.ts says why). Skullet reads the animation where the
  // bones are, when it measures: the mark sets it to none (bones.css), and a change inside the drawing makes it measure again.
  useEffect(() => {
    const element = root.current;
    if (!element || !measured) return;
    const timer = setTimeout(() => {
      element.setAttribute("data-bones-still", "");
      element.firstElementChild?.toggleAttribute("data-still", true);
    }, BONES.sweepCapMs);
    return () => clearTimeout(timer);
  }, [measured]);
  useLayoutEffect(() => {
    const element = root.current;
    if (!element || !measured) return;
    if (element.firstElementChild instanceof HTMLElement) markUnseen(element.firstElementChild);
    const ghost = new Ghost(element, { id });
    return () => ghost.destroy();
  }, [id, measured]);
  return (
    <Box ref={root} skullet-loading="" aria-hidden inert>
      <Box skullet-ghost="">{children}</Box>
      <Box skullet-snapshot="" />
      <Box skullet-layer="" />
    </Box>
  );
}

/**
 * Text this opaque has begun to arrive: the bone under it ends now. Half, not whole: under load the
 * frames come 25 ms or more apart and a text goes 0, 0.6, 1 in three of them; ended at half, no
 * bone is ever seen over whole text. The bone has been fading faster than the text comes in
 * (`hurryLeaving`), so it is faint by then.
 */
const ARRIVED = 0.5;
/** Bones on their way out: a region's under its content, bones put back to leave, a copy of bones unmounted whole. */
const LEAVING = '[data-bones="leaving"], [data-bones="copy"]';
/** What is not content: bones, a copy of them, words for screen readers only. */
const NOT_CONTENT = "[skullet-loading], [data-bones-layer], [data-bones='copy'], .sr-only";
/** How far outside the bars content is still measured: a part's own box may be this much smaller than what it draws. */
const REACH = 48;

/** How opaque an element is on screen: its own opacity times every box it sits in. Cached for one sweep. */
function shownOpacity(element: Element, cache: Map<Element, number>): number {
  const kept = cache.get(element);
  if (kept !== undefined) return kept;
  const parent = element.parentElement;
  const opacity = Number(getComputedStyle(element).opacity) * (parent ? shownOpacity(parent, cache) : 1);
  cache.set(element, opacity);
  return opacity;
}

/** Where each ended bar stood. Skullet reuses its bar nodes by index, so a node ended at one place can be handed another: there it is judged afresh. */
const ended = new WeakMap<Element, string>();
const placeOf = (bar: Element) => {
  const at = bar.getBoundingClientRect();
  return `${Math.round(at.left)},${Math.round(at.top)},${Math.round(at.width)},${Math.round(at.height)}`;
};
const overlaps = (a: DOMRect, b: DOMRect) =>
  Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)) > 1;

/**
 * No bone outlives its text. One sweep of the bones on their way out: every bar of theirs that
 * lies over text already in (by the text's own ranges, a partial overlap too) ends now. Only what
 * stands where the bars stand is measured: the walk goes down from the body and leaves a part
 * whose box is clear of every bar. True while bones are still leaving.
 */
function sweepBones(): boolean {
  const roots = [...document.querySelectorAll(LEAVING)];
  if (roots.length === 0) return false;
  // Skullet's bars stand in its layer's shadow root; a copy holds them as the layer's plain children.
  const bars = roots
    .flatMap((root) => [...root.querySelectorAll("[skullet-layer]")])
    .flatMap((layer) => [...(layer.shadowRoot ? layer.shadowRoot.querySelectorAll("[skullet-rect]") : layer.children)])
    .filter((bar) => {
      const was = ended.get(bar);
      if (was === undefined) return true;
      if (was === placeOf(bar)) return false;
      (bar as HTMLElement).style.removeProperty("opacity");
      ended.delete(bar);
      return true;
    });
  const boxes = bars.map((bar) => ({ bar, at: bar.getBoundingClientRect() })).filter(({ at }) => at.width * at.height > 0 && at.bottom > 0 && at.top < innerHeight);
  if (boxes.length === 0) return true;
  const near = {
    left: Math.min(...boxes.map(({ at }) => at.left)) - REACH,
    top: Math.min(...boxes.map(({ at }) => at.top)) - REACH,
    right: Math.max(...boxes.map(({ at }) => at.right)) + REACH,
    bottom: Math.max(...boxes.map(({ at }) => at.bottom)) + REACH,
  };
  const clear = (rect: DOMRect) => rect.right < near.left || rect.left > near.right || rect.bottom < near.top || rect.top > near.bottom;
  const cache = new Map<Element, number>();
  const range = document.createRange();
  const content: DOMRect[] = [];
  const walk = (parent: Element) => {
    for (let node = parent.firstChild; node; node = node.nextSibling) {
      if (node.nodeType === Node.TEXT_NODE) {
        if (!node.textContent?.trim()) continue;
        range.selectNodeContents(node);
        const rects = [...range.getClientRects()].filter((rect) => rect.width > 0 && rect.bottom > 0 && rect.top < innerHeight && !clear(rect));
        if (rects.length && shownOpacity(parent, cache) >= ARRIVED) content.push(...rects);
        continue;
      }
      if (!(node instanceof Element) || node.matches(NOT_CONTENT)) continue;
      const rect = node.getBoundingClientRect();
      if (node.localName === "svg" || node.localName === "img") {
        if (rect.width > 0 && rect.bottom > 0 && rect.top < innerHeight && !clear(rect) && shownOpacity(node, cache) >= ARRIVED) content.push(rect);
        continue;
      }
      // A box with no size may still hold content (`display: contents`, a wrapper its children overflow): it is walked.
      if (rect.width > 0 && rect.height > 0 && clear(rect)) continue;
      walk(node);
    }
  };
  walk(document.body);
  for (const { bar, at } of boxes) {
    if (!content.some((rect) => overlaps(at, rect))) continue;
    // Important, so Skullet's own fade (an animation, which outranks a plain inline style) cannot draw it again.
    (bar as HTMLElement).style.setProperty("opacity", "0", "important");
    ended.set(bar, placeOf(bar));
  }
  return true;
}

let frame = 0;
/** Bones are leaving: they are swept each frame until none is left. A window that draws no frame sweeps nothing, and has nothing to sweep. */
function watchLeaving() {
  if (frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    if (sweepBones()) watchLeaving();
  });
}

/**
 * Bones leave on Skullet's clock, the same fade and the same order by place as the content that
 * comes in over them, so a bone's fade could end a frame after its text was whole. Every finite
 * animation of the leaving bones (its bars in their shadow roots too) is hurried by
 * `BONES.leaveFaster`, so each bone has gone before the text over it is in.
 */
function hurryLeaving(root: Element) {
  const hurry = () => {
    for (const animation of document.getAnimations?.() ?? []) {
      const target = (animation.effect as KeyframeEffect | null)?.target;
      if (!target || animation.effect?.getComputedTiming().iterations === Infinity || animation.playbackRate === BONES.leaveFaster) continue;
      const host = target.getRootNode() instanceof ShadowRoot ? (target.getRootNode() as ShadowRoot).host : target;
      if (root === host || root.contains(host)) animation.updatePlaybackRate(BONES.leaveFaster);
    }
  };
  // Now and over the next frames: Skullet starts a leaving piece's fade when it has measured it.
  hurry();
  let frames = 0;
  const again = () => {
    hurry();
    if (++frames < 4 && root.isConnected) requestAnimationFrame(again);
  };
  requestAnimationFrame(again);
}

/** Skullet's fade of leaving bones, hurried, with the sweep that ends each bar under arrived text. */
function leaveBones(element: HTMLElement, box?: PaneBox): Promise<void> {
  const fade = fadeOut(element, box);
  hurryLeaving(element);
  watchLeaving();
  return fade;
}

/** `fade`, or `BONES.leaveCapMs`, whichever comes first: a hidden window draws no frame for a fade to end on. */
const capped = (fade: Promise<void>) => {
  let timer = 0;
  return Promise.race([fade, new Promise<void>((done) => (timer = window.setTimeout(done, BONES.leaveCapMs)))]).finally(() => clearTimeout(timer));
};

type Kind = "bones" | "content";
type Entry = { element: HTMLElement; box?: PaneBox };

/** One pane of a region, the bones or the content: Skullet brings it in and takes it out. */
function Pane({
  id,
  registry,
  enter,
  leaving,
  quiet,
  skeleton,
  snap,
  inline,
  onLeft,
  children,
}: {
  id: number;
  registry: Map<number, Entry>;
  /** It takes another pane's place (a region's first pane has nothing to replace). */
  enter: boolean;
  leaving: boolean;
  /** Arrive at once: the bones it replaces were never seen. */
  quiet: boolean;
  /** It is the bones. */
  skeleton: boolean;
  /** Its region lands at the content's height at once (`Region`'s `snap`). */
  snap: boolean;
  inline?: boolean;
  onLeft: (id: number) => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement & HTMLSpanElement>(null);
  const Box = inline ? "span" : "div";
  // How it arrives is fixed as it mounts: a pane that later leaves does not arrive again.
  const [arrival] = useState({ enter, quiet, skeleton });
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    registry.set(id, { element });
    void fadeIn(element, arrival.quiet ? instant : REVEAL, { initial: !arrival.enter });
    // The content's own fills (a group's band, a card's edge) are no piece of Skullet's and would stand at once.
    if (arrival.enter && !arrival.quiet && !arrival.skeleton && !still()) element.animate(BONES.surfaces.keyframes, BONES.surfaces.timing);
    return () => {
      registry.delete(id);
    };
  }, [id, registry, arrival]);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!leaving || !element) return;
    const box = registry.get(id)?.box;
    const fade = skeleton ? leaveBones(element, box) : fadeOut(element, box);
    // `snap`: Skullet eases the region's height from the leaving pane's to the content's, started in `fadeOut`'s
    // first microtask; finished at once, the region stands at the content's height in this frame.
    if (snap) {
      const region = element.parentElement;
      void Promise.resolve().then(() => {
        for (const animation of region?.getAnimations() ?? []) {
          if ((animation.effect as KeyframeEffect | null)?.getKeyframes().some((keyframe) => "height" in keyframe)) animation.finish();
        }
      });
    }
    void capped(fade).then(() => onLeft(id));
    // Every one of these is fixed while a pane leaves (`onLeft` is its region's own bound method): the fade starts once.
  }, [leaving, id, registry, skeleton, snap, onLeft]);
  return (
    <Box ref={ref} skullet-pane="">
      {children}
    </Box>
  );
}

type PanesProps = {
  kind: Kind;
  node: ReactNode;
  /** The bones have not shown yet: content that lands now has nothing on screen to follow. */
  held: boolean;
  snap: boolean;
  inline?: boolean;
  /** Called once the content has been on screen long enough to be read for its shape. */
  onContent: (element: HTMLElement) => void;
  /** `first`: the pane on screen is the one the region mounted with. */
  children: (panes: ReactNode, bonesLeaving: boolean, first: boolean) => ReactNode;
};
type PanesState = { id: number; kind: Kind; node: ReactNode; quiet: boolean; leaving: { id: number; kind: Kind; node: ReactNode }[] };

/**
 * A region's two panes. A class for what a function cannot say plainly: the pane on screen goes on
 * showing what it last drew as it leaves (the node before this render's), and a leaving pane is
 * measured where it stands before the commit that brings its replacement changes the page.
 */
class Panes extends Component<PanesProps, PanesState> {
  state: PanesState = { id: 0, kind: this.props.kind, node: this.props.node, quiet: false, leaving: [] };
  private registry = new Map<number, Entry>();
  private timer = 0;

  static getDerivedStateFromProps(props: PanesProps, state: PanesState): Partial<PanesState> {
    if (props.kind === state.kind) return { node: props.node };
    return {
      id: state.id + 1,
      kind: props.kind,
      node: props.node,
      quiet: props.kind === "content" && props.held,
      leaving: [...state.leaving, { id: state.id, kind: state.kind, node: state.node }],
    };
  }

  getSnapshotBeforeUpdate(_props: PanesProps, previous: PanesState) {
    for (const pane of this.state.leaving) {
      if (previous.leaving.some((other) => other.id === pane.id)) continue;
      const entry = this.registry.get(pane.id);
      if (entry) entry.box = boxOf(entry.element);
    }
    return null;
  }

  componentDidMount() {
    this.landed();
  }

  componentDidUpdate(_props: PanesProps, previous: PanesState) {
    if (previous.id === this.state.id) return;
    // Bones that were on screen have just left it: what mounts in their place inside `BONES.followsMs` follows them.
    if (previous.kind === "bones" && !this.state.quiet) bonesLeftAt = performance.now();
    this.landed();
  }

  componentWillUnmount() {
    clearTimeout(this.timer);
  }

  /** Content is on screen: from now every wait counts from its own start, and the content is read for its shape once the reveal is over. */
  private landed() {
    clearTimeout(this.timer);
    if (this.state.kind !== "content") return;
    settled = true;
    const id = this.state.id;
    this.timer = window.setTimeout(() => {
      const content = this.registry.get(id)?.element;
      if (content) this.props.onContent(content);
    }, BONES.rememberMs);
  }

  private left = (id: number) => this.setState((state) => ({ leaving: state.leaving.filter((pane) => pane.id !== id) }));

  render() {
    const { id, kind, node, quiet, leaving } = this.state;
    // One keyed list: the pane on screen keeps its place in the page as it joins the ones on their way out.
    const panes = [
      ...leaving.map((pane) => (
        <Pane key={pane.id} id={pane.id} registry={this.registry} enter={false} leaving quiet={false} skeleton={pane.kind === "bones"} snap={this.props.snap} inline={this.props.inline} onLeft={this.left}>
          {pane.node}
        </Pane>
      )),
      <Pane key={id} id={id} registry={this.registry} enter={id > 0} leaving={false} quiet={quiet} skeleton={kind === "bones"} snap={false} inline={this.props.inline} onLeft={this.left}>
        {node}
      </Pane>,
    ];
    return this.props.children(
      panes,
      // Bones that were never seen leave in the same commit: they are not bones on their way out.
      !quiet && leaving.some((pane) => pane.kind === "bones"),
      id === 0,
    );
  }
}

/** Where a region's bones were last painted, read after each change that may have moved them: bones unmounted whole are laid back there. */
function useStood(root: { current: HTMLElement | null }, loading: boolean) {
  const stood = useRef<DOMRect | null>(null);
  useEffect(() => {
    const element = root.current;
    if (!loading || !element) return;
    let asked = 0;
    const read = () => {
      asked = 0;
      if (element.matches(SHOWN)) stood.current = element.getBoundingClientRect();
    };
    const ask = () => {
      if (!asked) asked = requestAnimationFrame(read);
    };
    const sized = new ResizeObserver(ask);
    sized.observe(element);
    addEventListener("scroll", ask, { passive: true, capture: true });
    addEventListener("resize", ask);
    return () => {
      cancelAnimationFrame(asked);
      sized.disconnect();
      removeEventListener("scroll", ask, { capture: true });
      removeEventListener("resize", ask);
    };
  }, [root, loading]);
  return stood;
}

/** The region itself (components/bones.tsx `Region` says what it is for). */
export function Region({ loading, bones, children, id, label = "Loading", hold = BONES.holdMs, snap = false, fill, inline, on, className }: RegionProps) {
  const Box = inline ? "span" : "div";
  const [left] = useState(() => (loading ? holdLeft(hold) : 0));
  const [shown, setShown] = useState(left === 0);
  // Content that mounts where bones still stand (a surface whose read beat its chunk's fallback): it has no bones of
  // its own to follow, so it arrives over the ones that are leaving (`bridgeBones`), not whole.
  const [arrives] = useState(() => !loading && bonesFollow());
  const root = useRef<HTMLDivElement & HTMLSpanElement>(null);
  // The hold. Content that lands inside it has nothing on screen to follow (`Panes` reads `held` in that commit), and from then on the region is past its hold.
  useEffect(() => {
    if (shown) return;
    const timer = setTimeout(() => setShown(true), loading ? left : 0);
    return () => clearTimeout(timer);
  }, [shown, left, loading]);

  const stood = useStood(root, loading);
  // A layout effect: its cleanup runs before the commit takes the node away, so bones that leave with their region can still be read.
  useLayoutEffect(() => {
    const element = root.current;
    return () => {
      settled = true;
      if (!element?.matches(SHOWN)) return;
      bonesLeftAt = performance.now();
      bridgeBones(
        element,
        {
          fadeIn: (arrived) => capped(fadeIn(arrived, REVEAL)),
          fadeOut: (leaving, box) => capped(leaveBones(leaving, box)),
          still,
          surfaces: (arrived) => void arrived.animate(BONES.surfaces.keyframes, BONES.surfaces.timing),
        },
        stood.current,
      );
      watchLeaving();
    };
  }, [stood]);

  const node: ReactNode = loading ? (
    <InBones.Provider value>
      <Drawing id={id} measured={shown} inline={inline}>
        {typeof bones === "function" ? bones() : bones}
      </Drawing>
    </InBones.Provider>
  ) : (
    <InRegion.Provider value>{children}</InRegion.Provider>
  );

  return (
    <Panes kind={loading ? "bones" : "content"} node={node} held={!shown} snap={snap} inline={inline} onContent={(content) => (id ? remember(content, id) : undefined)}>
      {(panes, bonesLeaving, first) => (
        <Box
          ref={root}
          skullet-reveal=""
          data-region=""
          data-inline={inline ? "" : undefined}
          // "held" and "shown" while it waits; "leaving" while its bones go out under the content.
          data-bones={loading ? (shown ? "shown" : "held") : bonesLeaving ? "leaving" : undefined}
          data-bones-waited={loading && left > 0 ? "" : undefined}
          data-bones-on={on}
          data-arrive={arrives && !loading && first ? "" : undefined}
          aria-busy={loading || undefined}
          className={regionClass({ fill, inline, className })}
        >
          {/* What a screen reader hears of the wait, and only of a wait that shows. An empty label is a region whose
              box already names the wait: it says nothing, and has nothing to say it with. */}
          {label ? (
            <span role="status" className="sr-only">
              {loading && shown ? label : ""}
            </span>
          ) : null}
          {panes}
        </Box>
      )}
    </Panes>
  );
}

/** A lone bone joins the sweep (components/bones.tsx `Bone`); returns its stop. */
export function sweepBone(element: HTMLElement): () => void {
  shimmer(element);
  const stop = () => {
    for (const animation of element.getAnimations()) animation.cancel();
    element.style.backgroundImage = "";
  };
  // As a drawing's bones do, it goes still once it has stood `BONES.sweepCapMs`.
  const timer = setTimeout(stop, BONES.sweepCapMs);
  return () => {
    clearTimeout(timer);
    stop();
  };
}
