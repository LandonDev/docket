import { useSyncExternalStore } from "react";
import type { ContextChip } from "@shared/work";
import { chipPort } from "../../lib/contextChips";
import { sessionStore } from "../../lib/tcserver/store";

/**
 * What a message is about (docs/DESIGN.md "The canvas pane", "A chip in the
 * composer"): a task, a mail, an event or a selection in a canvas item, held
 * per thread until its composer sends. A view that starts a thread from a
 * task puts the chip on the draft (`addContextChip`), Ask in a canvas puts a
 * selection on the thread beside it, and the composer draws the row, lets a
 * chip alone be sent and writes each chip into the message as a line the
 * model reads. A draft's first chip also rides `session.create` as `about`,
 * so the host links the thread to it. The composer is in the first paint and
 * this is not: it reaches the store through `chipPort` (lib/contextChips.ts),
 * which this module fills as it loads.
 */

const NONE: readonly ContextChip[] = [];
/** A composer holds a few things a message is about, not a list. */
export const CHIPS_MAX = 8;
const chips = new Map<string, readonly ContextChip[]>();
/** What a draft's first send was about, until its create takes it. */
const abouts = new Map<string, ContextChip>();
const listeners = new Set<() => void>();

const same = (a: ContextChip, b: ContextChip): boolean => a.kind === b.kind && a.quote === b.quote && JSON.stringify(a.ref) === JSON.stringify(b.ref);

function put(sessionId: string, next: readonly ContextChip[]): void {
  if (next.length === 0) chips.delete(sessionId);
  else chips.set(sessionId, next);
  for (const listener of listeners) listener();
  chipPort.changed();
}

export const contextChipsOf = (sessionId: string | undefined): readonly ContextChip[] => (sessionId ? chips.get(sessionId) : undefined) ?? NONE;

/** Puts a chip in a thread's composer; one already there is not added twice. */
export function addContextChip(sessionId: string, chip: ContextChip): void {
  const have = contextChipsOf(sessionId);
  if (have.length >= CHIPS_MAX || have.some((c) => same(c, chip))) return;
  put(sessionId, [...have, chip]);
}

export function removeContextChip(sessionId: string, index: number): void {
  put(sessionId, contextChipsOf(sessionId).filter((_, i) => i !== index));
}

/** The composer sent: its chips go with the message. A draft's first send keeps its first chip for the create. */
export function takeContextChips(sessionId: string, firstSend: boolean): readonly ContextChip[] {
  const sent = contextChipsOf(sessionId);
  if (sent.length === 0) return sent;
  if (firstSend) abouts.set(sessionId, sent[0]);
  put(sessionId, NONE);
  return sent;
}

/**
 * What `session.create` says the new thread is about. Kept until the thread
 * exists, so a create that failed and is tried again still says it.
 */
export function aboutFor(sessionId: string, created: (id: string) => boolean = (id) => !!sessionStore.metaOf(id)): ContextChip | undefined {
  if (!created(sessionId)) return abouts.get(sessionId);
  abouts.delete(sessionId);
  return undefined;
}

/** Where a chip points, in words a model can act on. */
function refWords(ref: ContextChip["ref"]): string {
  if (ref.at === "lifeos") return `LifeOS ${ref.table} ${ref.id}`;
  if (ref.at === "file") return ref.path;
  return JSON.stringify(ref);
}

/** One chip as the model reads it: a line of its own, a selection's words quoted under it. */
export function chipLine(chip: ContextChip): string {
  const head = `About this ${chip.kind}: ${chip.label} (${refWords(chip.ref)})`;
  const quote = chip.kind === "selection" && chip.quote ? chip.quote.trim() : "";
  return quote ? `${head}\n${quote.split("\n").map((line) => `> ${line}`).join("\n")}` : head;
}

/**
 * The message as sent: each chip's line, then the person's words. A message
 * that opens with a slash command keeps the command first, since a harness
 * reads a command only at the start, and the chips follow it.
 */
export function withContextChips(sent: readonly ContextChip[], text: string): string {
  if (sent.length === 0) return text;
  const lines = sent.map(chipLine).join("\n");
  if (!text) return lines;
  return text.startsWith("/") ? `${text}\n\n${lines}` : `${lines}\n\n${text}`;
}

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** A thread's chips, live. */
export function useContextChips(sessionId: string | undefined): readonly ContextChip[] {
  return useSyncExternalStore(subscribe, () => contextChipsOf(sessionId));
}

/** Test seam: forget everything (a module-level store). */
export function resetContextChips(): void {
  chips.clear();
  abouts.clear();
}

chipPort.set({
  count: (sessionId) => contextChipsOf(sessionId).length,
  send: (sessionId, firstSend, text) => withContextChips(takeContextChips(sessionId, firstSend), text),
  about: (sessionId) => aboutFor(sessionId),
});
