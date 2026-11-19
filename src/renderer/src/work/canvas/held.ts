import type { HeldRef } from "@shared/work";

/**
 * Where a canvas kind's `shell.held(ref)` goes: the surface that shows held
 * acts (the Outbox) names itself here once it exists, and until then the
 * call does nothing. One opener at a time; the last to register wins.
 */
type Opener = (ref: HeldRef, environmentId: string) => void;
let opener: Opener | null = null;

/** Registers the surface that opens a held act; returns its off. */
export function onOpenHeld(open: Opener): () => void {
  opener = open;
  return () => {
    if (opener === open) opener = null;
  };
}

export function openHeld(ref: HeldRef, environmentId: string): void {
  opener?.(ref, environmentId);
}
