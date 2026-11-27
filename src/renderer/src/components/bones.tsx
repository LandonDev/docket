// Out of the React Compiler's hands: every piece here is a thin pass-through whose props are new each render (a
// drawing, a function), so a memo of it never hits, and its cache code is 4 kB of the first paint for nothing.
"use no memo";
import { createContext, useContext, useLayoutEffect, useRef, useState, useSyncExternalStore, type ComponentProps, type CSSProperties, type ReactNode } from "react";
import { cn } from "@renderer/lib/cn";

/*
 * Loading states (docs/agents/loading-bones.md; docs/DESIGN.md "Loading and
 * empty states"). A skeleton is the screen itself, drawn from a sample:
 * Skullet lays the drawing out unseen, measures it and draws one bone for
 * each line of text, glyph and block, with one sweep across them all. When
 * the read answers, the content comes in over its bones.
 *
 * This file is what app code imports. Skullet itself rides a chunk of its
 * own (bonesEngine.tsx, the one file that imports it): the first paint's
 * budget has no room for it, and it is asked for as this module loads, so it
 * is in hand before any bones are due (they wait 150 ms). A region that
 * mounts before it has landed is plain: nothing while it waits, its content
 * as it is. It takes the engine up only while it waits, when there is no
 * content to remount.
 */

type Engine = typeof import("./bonesEngine");

let engine: Engine | null = null;
let asked: Promise<void> | null = null;
const told = new Set<() => void>();

/** Asks for the engine, once; settles when it is in. Tests await it before they look for bones. */
export function bonesReady(): Promise<void> {
  asked ??= import("./bonesEngine").then(
    (module) => {
      engine = module;
      for (const tell of [...told]) tell();
    },
    (error: unknown) => {
      asked = null;
      console.warn("[bones] the engine failed to load", error);
    },
  );
  return asked;
}
void bonesReady();

/** The engine's script for a still page (scripts/ui-preview.ts), once `bonesReady` has settled. */
export const bonesPreviewScript = (): string => engine?.previewScript() ?? "";

const subscribe = (tell: () => void) => {
  told.add(tell);
  return () => {
    told.delete(tell);
  };
};
const engineNow = () => engine;
const useEngine = () => useSyncExternalStore(subscribe, engineNow, engineNow);

export const InBones = createContext(false);
/** True inside a region's content: what it holds arrives by the region's own reveal. */
export const InRegion = createContext(false);

/** True inside bones. The drawing is unseen and inert, but its effects still run: a piece that
 *  subscribes, registers keys, asks its host or reads by a sample id asks this first and skips it. */
export function useInBones(): boolean {
  return useContext(InBones);
}

export type RegionProps = {
  /** The read is out. */
  loading: boolean;
  /** The drawing the bones are measured from: the content's own piece given a sample, or a function that makes it (called only while loading). */
  bones: ReactNode | (() => ReactNode);
  children?: ReactNode;
  /** Names the region, so its next bones are the shape it last showed and not the sample's: say what the shape hangs on ("notes:list"). */
  id?: string;
  /** What a screen reader hears while the bones show. */
  label?: string;
  /** How long the bones wait before they show (150 ms); 0 for bones that follow a wait already made. */
  hold?: number;
  /** Land at the content's height with no ease, for content whose height the sample cannot know. */
  snap?: boolean;
  /** Take the room its flex parent has (a list in its pane). Without it the region is as tall as what it holds. */
  fill?: boolean;
  /** One value in a line of words (a branch's name, a count): the region is a box in the line, on the words' baseline, and what it holds is phrasing content. */
  inline?: boolean;
  /** The ground the bones lie on, where it is not the page: `stage` or `matte` (docs/DESIGN.md `skeleton-stage`, `skeleton-matte`), or `paper`, white in both themes (a PDF's page, a slide not yet drawn). */
  on?: "stage" | "matte" | "paper";
  className?: string;
};

/** A region's box: a column, and so is each of its panes; inline, a box in its line of words (bones.css). */
export const regionClass = ({ fill, inline, className }: Pick<RegionProps, "fill" | "inline" | "className">) =>
  cn("relative min-w-0", inline ? "inline-flex max-w-full align-baseline" : "flex flex-col", fill ? "min-h-0 flex-1" : null, className);

/** A region before the engine has landed: nothing while it waits, its content as it is, in the box the engine draws. */
function ColdRegion({ loading, children, fill, inline, on, className }: RegionProps) {
  const Box = inline ? "span" : "div";
  return (
    <Box data-region="" data-inline={inline ? "" : undefined} data-bones={loading ? "held" : undefined} data-bones-on={on} aria-busy={loading || undefined} className={regionClass({ fill, inline, className })}>
      {loading ? null : (
        <Box skullet-pane="">
          <InRegion.Provider value>{children}</InRegion.Provider>
        </Box>
      )}
    </Box>
  );
}

/**
 * A loading region: one part of a screen with a read of its own. While
 * `loading` it is `bones` (the part itself drawn from a sample, at rest);
 * when the read answers, `children` come in over the bones by Skullet's
 * reveal, and the regions still waiting go on sweeping. Give every part with
 * its own read its own region, so nothing waits for the slowest. An error
 * and an empty state are content: they go inside, with `loading` false.
 */
export function Region(props: RegionProps) {
  const live = useEngine();
  // Which one this region runs: it changes only while the region waits.
  const [warm, setWarm] = useState(live !== null);
  if (!warm && live && props.loading) setWarm(true);
  if (warm && live) return <live.Region {...props} />;
  return <ColdRegion {...props} />;
}

/**
 * Bones alone: what is inside is drawn as bones for as long as this is
 * mounted. For a wait with no content of its own to follow (a lazy
 * surface's fallback); a part of a screen is a `Region`. When it is taken
 * away and content mounts where it stood, a copy of the bones fades out
 * over it (bonesBridge.ts).
 */
export function Bones({ children, ...region }: Omit<RegionProps, "loading" | "bones" | "children" | "id" | "snap"> & { children: ReactNode }) {
  return <Region {...region} loading bones={children} />;
}

/**
 * One read, drawn by one function: a region whose bones are that function
 * given the sample and whose content is the same function given the answer.
 * It waits while `data` is null or undefined; `failed` (the read's error
 * line with its Retry) stands in the content's place.
 */
export function Loaded<T>({
  data,
  sample,
  failed,
  bones,
  children,
  ...region
}: Omit<RegionProps, "loading" | "bones" | "children"> & {
  data: T | null | undefined;
  sample: T;
  failed?: ReactNode;
  /** What the bones are, given the sample's drawing (a frame round it the content does not have). */
  bones?: (drawn: ReactNode) => ReactNode;
  children: (data: T) => ReactNode;
}) {
  const failure = failed ?? null;
  return (
    <Region {...region} loading={data == null && failure === null} bones={() => (bones ? bones(children(sample)) : children(sample))}>
      {failure ?? (data != null ? children(data) : null)}
    </Region>
  );
}

/**
 * Content that takes the place of bones it is no region's: the branch
 * beside a `Bones` (`loading ? <Bones>…</Bones> : <Arrive>…</Arrive>`).
 * Where bones stood a moment ago it comes in over them by the reveal
 * (bonesBridge.ts); anywhere else, and inside a `Region`, it is plain.
 * `Region` is the form to write; this keeps a branch that cannot be one.
 */
export function Arrive({ children, className }: { children: ReactNode; className?: string }) {
  const inRegion = useContext(InRegion);
  const [arriving, setArriving] = useState(() => !inRegion && (engine?.bonesFollow() ?? false));
  return (
    <div
      data-arrive={arriving ? "" : undefined}
      // Once it has arrived it is plain content again: an animation left on it keeps its text on a layer of its own.
      onAnimationEnd={(event) => {
        if (event.target === event.currentTarget) setArriving(false);
      }}
      className={className}
    >
      {children}
    </div>
  );
}

/**
 * A lone bone, for what has no words to measure: a picture, a chart, a
 * frame on its way. Inside a drawing it is one block of it; alone it sweeps
 * with the rest. A line of text is never one of these: write the words and
 * Skullet draws the bar.
 */
export function Bone({
  width,
  height,
  radius,
  className,
  style,
  ...rest
}: Omit<ComponentProps<"span">, "children"> & {
  width?: number | string;
  height?: number | string;
  radius?: number | string;
  style?: CSSProperties;
}) {
  const inBones = useContext(InBones);
  const live = useEngine();
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    if (inBones || !live || !ref.current) return;
    return live.sweepBone(ref.current);
  }, [inBones, live]);
  return <span {...rest} ref={ref} data-bone="" skullet-block="" aria-hidden className={cn("block shrink-0", className)} style={{ width, height, borderRadius: radius, ...style }} />;
}
