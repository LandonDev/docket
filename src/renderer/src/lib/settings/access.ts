import { RUNTIME_MODE_HINT, RUNTIME_MODE_LABEL } from "../session";
import type { PermissionPolicy, ThreadDefaults } from "../tcserver/types";

/**
 * Access, as Settings says it wherever it is chosen (plan section 3): the composer's three names, each with its one
 * line, read from the composer's own table (lib/session.ts). Away's own line tells it apart from Full access.
 */
export const ACCESS_LABEL: Record<ThreadDefaults["permission"], string> = {
  safe: RUNTIME_MODE_LABEL.supervised,
  edits: RUNTIME_MODE_LABEL["auto-accept-edits"],
  auto: RUNTIME_MODE_LABEL["full-access"],
};

export const ACCESS_LINE: Record<ThreadDefaults["permission"], string> = {
  safe: RUNTIME_MODE_HINT.supervised,
  edits: RUNTIME_MODE_HINT["auto-accept-edits"],
  auto: RUNTIME_MODE_HINT["full-access"],
};

export const ACCESS_ORDER: readonly ThreadDefaults["permission"][] = ["safe", "edits", "auto"];

/** What choosing Full access as a default asks first (plan section 5). */
export const FULL_ACCESS_CONFIRM = {
  title: "Start new threads with full access",
  body: "They edit files and run commands without asking. Sends, posts and payments still wait for you.",
  action: "Use full access",
} as const;

/** The same names and lines, by the policy's own type. */
export const ACCESS_NAMES: Record<PermissionPolicy, string> = ACCESS_LABEL;
export const ACCESS_LINES: Record<PermissionPolicy, string> = ACCESS_LINE;

/** "Full access asks before nothing. Sends, posts and payments still wait.": a level and its line, one sentence. */
export const accessWords = (policy: PermissionPolicy): string => {
  const line = ACCESS_LINES[policy] ?? ACCESS_LINES.safe;
  const said = `${ACCESS_NAMES[policy] ?? ACCESS_NAMES.safe} ${line.charAt(0).toLowerCase()}${line.slice(1)}`;
  return /[.!?]$/.test(said) ? said : `${said}.`;
};
