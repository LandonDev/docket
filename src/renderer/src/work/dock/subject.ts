import type { ContextChip } from "@shared/work";
import type { Session } from "../../lib/session";

/**
 * What a docked chat is about (docs/agents/work-files.md "Ask", work-mail.md "The chat beside the mail"): a file tab,
 * a mail, the rows he ticked. The dock keeps one chat a subject this run, keyed by `key`.
 */
export interface DockSubject {
  /** One chat a key: the same key shows the same draft or thread again. */
  key: string;
  /** What the head says while the chat is a draft. */
  title: string;
  /** The chips the first message carries. */
  chips: readonly ContextChip[];
  /**
   * `composer`: the chips sit in the draft's composer, where he may take them off (Files). `send`: none sits there,
   * since the head already names the subject; the first send carries them itself (Mail).
   */
  chipIn: "composer" | "send";
  /** The subject's thread of this workspace from before, if there is one. */
  find(): Promise<string | null>;
  /** Run by the first send, between the thread's create and its message. */
  hold?(sessionId: string): Promise<void>;
  /** A hold that fails stops the send ("The chat did not start"), and runs again before the next. */
  mustHold?: boolean;
  /** Changes a new draft as it is made (Mail's starts on Claude where the default harness cannot be narrowed). */
  seed?(draft: Session): Session;
}
