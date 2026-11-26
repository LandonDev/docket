import { cn } from "../lib/cn";
import { HARNESS_TITLE } from "../lib/session";
import { asHarness } from "../lib/tcserver/store";
import type { ThreadType } from "../lib/tcserver/types";
import { THREAD_LABELS } from "../surfaces/threads/threadTypes";
import { TypeGlyph } from "../surfaces/threads/TypeGlyph";
import { HarnessIcon } from "./HarnessIcon";

/**
 * A thread row's provider and trailing type, which Work's rows draw (docs/DESIGN.md "The column"): the provider in
 * the lead slot, where a code row has its type, and the type after the title only when it is not a plain chat. The
 * Work column hands the lead slot to a live mark (working, asks, failed, held) and Work Chats keeps its state at the
 * row's end, so a row never draws two marks in one place.
 */

/** The thread's provider at 12px, as a code row's type glyph; nothing for a row with no provider. */
export function ProviderLead({ provider }: { provider?: string }) {
  if (!provider) return null;
  const harness = asHarness(provider);
  return (
    <span data-provider={harness} className="contents">
      <HarnessIcon harness={harness} className="size-3" />
    </span>
  );
}

/** A type other than chat, after the title; a chat says nothing. */
export function TrailingType({ type, className }: { type: ThreadType | null | undefined; className?: string }) {
  return type && type !== "chat" ? <TypeGlyph type={type} className={cn("size-3 self-center", className)} /> : null;
}

/** What the two marks say to a screen reader: "Research, Codex"; the type only when it is drawn. */
export function markWords(row: { threadType?: ThreadType | null; provider?: string }): string[] {
  return [row.threadType && row.threadType !== "chat" ? THREAD_LABELS[row.threadType] : null, row.provider ? HARNESS_TITLE[asHarness(row.provider)] : null].filter(
    (word): word is string => !!word,
  );
}
