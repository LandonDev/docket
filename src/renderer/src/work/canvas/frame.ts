import { useMemo, useRef, useState } from "react";
import type { CanvasItem, ContextChip } from "@shared/work";
import { loadToast } from "../../components/ui/toaster";
import type { CanvasMode, CanvasSelection, CanvasShell, MoreEntry, Presence, ReviewAdapter, StatusLine, WrittenLine } from "./kind";
import { openHeld } from "./held";
import { openItem } from "./store";

/** What the shown item's kind has told the frame (kind.ts `CanvasShell`). */
export interface Feeds {
  review: ReviewAdapter | null;
  selection: CanvasSelection | null;
  presence: readonly Presence[];
  mode: CanvasMode | null;
  status: StatusLine | null;
  written: WrittenLine | null;
  detail: string | null;
  more: readonly MoreEntry[] | null;
  /** The kind said whether the item has opened; null while it has not said. */
  ready: boolean | null;
}

const NO_PEOPLE: readonly Presence[] = [];
export const NO_FEEDS: Feeds = { review: null, selection: null, presence: NO_PEOPLE, mode: null, status: null, written: null, detail: null, more: null, ready: null };

/** An error a person should see once, in the thread's toast stack. */
export function sayError(error: unknown, fallback: string): void {
  const message = error instanceof Error && error.message ? error.message : fallback;
  void loadToast().then((toast) => toast.error(message));
}

/**
 * The frame's state for the item shown, and the `shell` its kind talks to.
 * The feeds belong to one item: another item shown starts from nothing, and
 * a call that arrives from the body of an item no longer shown is dropped.
 * `ask` is the seat's Ask, which a kind's own selection menu goes through.
 */
export function useFrame(environmentId: string, sessionId: string, item: CanvasItem | null, ask?: (chip: ContextChip) => void): { feeds: Feeds; shell: CanvasShell } {
  const id = item?.id ?? null;
  const asking = useRef(ask);
  asking.current = ask;
  const [state, setState] = useState<{ id: string | null; feeds: Feeds }>({ id, feeds: NO_FEEDS });
  if (state.id !== id) setState({ id, feeds: NO_FEEDS });
  const kind = item?.kind;
  const title = item?.title;
  const source = item?.source;
  const shell = useMemo<CanvasShell>(() => {
    const feed =
      <K extends keyof Feeds>(key: K) =>
      (value: Feeds[K]): void =>
        setState((prev) => (prev.id !== id || prev.feeds[key] === value ? prev : { id, feeds: { ...prev.feeds, [key]: value } }));
    return {
      review: feed("review"),
      selection: feed("selection"),
      ask: (chip) => asking.current?.(chip),
      presence: (people) => feed("presence")(people.length === 0 ? NO_PEOPLE : people),
      mode: feed("mode"),
      statusLine: feed("status"),
      written: feed("written"),
      detail: feed("detail"),
      ready: feed("ready"),
      more: (entries) => feed("more")(entries && entries.length > 0 ? entries : null),
      openHistory: () => {
        if (!source || !title || kind === "history") return;
        openItem(environmentId, sessionId, { kind: "history", source, title }).catch((error: unknown) => sayError(error, "Couldn't open the history"));
      },
      held: (ref) => openHeld(ref, environmentId),
    };
    // The source is the item's own and never changes under one id.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [environmentId, sessionId, id, kind, title]);
  return { feeds: state.id === id ? state.feeds : NO_FEEDS, shell };
}
