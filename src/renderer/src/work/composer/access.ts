import type { RuntimeMode } from "../../lib/session";

/**
 * Access in Work's words (docs/agents/new-thread-access.md "In a Work thread"): what a Work thread does on its own in
 * each mode. The modes are the code picker's three; only their words change. What reaches other people waits for his
 * press in every mode (the Outbox's hold), which the list's last line says once.
 */
export const WORK_ACCESS_LABEL: Record<RuntimeMode, string> = {
  supervised: "Asks first",
  "auto-accept-edits": "Edits on its own",
  auto: "Edits on its own",
  "full-access": "Works on its own",
};

export const WORK_ACCESS_HINT: Record<RuntimeMode, string> = {
  supervised: "Asks before it changes a file or runs a program.",
  "auto-accept-edits": "Changes files on its own, asks before it runs a program.",
  auto: "Changes files on its own, asks before it runs a program.",
  "full-access": "Changes files and runs programs without asking.",
};

/** The hold, said once under the modes: no mode sends anything for him. */
export const WORK_ACCESS_HOLD = "Sending, posting and sharing always wait for your press.";
