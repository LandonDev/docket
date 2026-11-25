import { useMemo, useRef, useState } from "react";
import type { CanvasItem, ContextChip } from "@shared/work";
import { loadToast } from "../../components/ui/toaster";
import { registry } from "../../lib/connection";
import { nameInLine } from "../../lib/hostWords";
import { workErrorWords } from "../../lib/workErrorWords";
import type { CanvasMode, CanvasSelection, CanvasShell, MoreEntry, Presence, ReviewAdapter, SavedLine, StatusLine, WrittenLine } from "./kind";
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
  /** What the kind said of saving; null while it has not said. Read by a file's header in the Files place. */
  saved: SavedLine | null;
}

const NO_PEOPLE: readonly Presence[] = [];
export const NO_FEEDS: Feeds = { review: null, selection: null, presence: NO_PEOPLE, mode: null, status: null, written: null, detail: null, more: null, ready: null, saved: null };

/**
 * An error a person should see once, in the thread's toast stack: the act's own line (`fallback`, "Couldn't refresh")
 * as its title, and the host's answer in plain words under it (`workErrorWords`, naming the computer asked where the
 * caller gives `environmentId`), none when the answer has no plain words or repeats the title. Never a method's name or a path.
 */
export function sayError(error: unknown, fallback: string, environmentId?: string | null): void {
  const under = errorDescription(error, environmentId);
  // A refusal raised with its own sentence as the act's line (`sayError(new Error(why), why)`) is said once.
  void loadToast().then((toast) => toast.error(fallback, under?.description === fallback ? undefined : under));
}

/** The plain words under `sayError`'s title, or none. */
export function errorDescription(error: unknown, environmentId?: string | null): { description: string } | undefined {
  const name = environmentId ? registry.environment?.(environmentId)?.name : undefined;
  const words = workErrorWords(error, name ? { host: nameInLine(name) } : {});
  return words ? { description: words } : undefined;
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
  // A mail's file is read only until he keeps it (work-mail.md "Attachments"): whatever its kind says, the bar draws no
  // mode, no stepper and no written line, and an agent's marks on the private copy stay marks in the body.
  const readOnly = source?.at === "mail";
  const shell = useMemo<CanvasShell>(() => {
    const feed =
      <K extends keyof Feeds>(key: K) =>
      (value: Feeds[K]): void =>
        setState((prev) => (prev.id !== id || prev.feeds[key] === value ? prev : { id, feeds: { ...prev.feeds, [key]: value } }));
    const ignored = (): void => undefined;
    return {
      review: readOnly ? ignored : feed("review"),
      selection: feed("selection"),
      ask: (chip) => asking.current?.(chip),
      presence: (people) => feed("presence")(people.length === 0 ? NO_PEOPLE : people),
      mode: readOnly ? ignored : feed("mode"),
      statusLine: feed("status"),
      written: readOnly ? ignored : feed("written"),
      detail: feed("detail"),
      ready: feed("ready"),
      more: (entries) => feed("more")(entries && entries.length > 0 ? entries : null),
      saved: feed("saved"),
      openHistory: () => {
        if (!source || !title || kind === "history") return;
        openItem(environmentId, sessionId, { kind: "history", source, title }).catch((error: unknown) => sayError(error, "Couldn't open the history", environmentId));
      },
      held: (ref) => openHeld(ref, environmentId),
    };
    // The source is the item's own and never changes under one id.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [environmentId, sessionId, id, kind, title, readOnly]);
  return { feeds: state.id === id ? state.feeds : NO_FEEDS, shell };
}
