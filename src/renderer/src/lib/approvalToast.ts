import { pendingApprovalIndex, sessionDisplayTitle, type Block, type Session } from "./session";
import { toolCallLabel } from "../surfaces/transcriptActivity";
import { humanName } from "./toolPhrase";
import { sessionStore } from "./tcserver/store";

export type PendingApprovalNotice = {
  sessionId: string;
  requestId: string | number;
  /** What the call does, in words ("Create empty file notes.txt": it has not run): the toast's line, where no card shows it. */
  label: string;
  /** The tool's name ("Bash"): a state's detail, "Needs you  approve Bash", beside a card that shows the rest. */
  tool: string;
  block: Block;
};

/** Toast data never retains a block or a Session. */
export type ApprovalToastNotice = Pick<PendingApprovalNotice, "sessionId" | "requestId" | "label" | "tool"> & {
  title: string;
  /** Run now and Skip in Allow and Deny's place (Block.approval.choices). */
  choices?: "run-skip";
  /** The thread's host away (D5): both presses held, this their tooltip. */
  held?: string | null;
};

const approvalLabels = new WeakMap<Block, { cwd: string; label: string; tool: string }>();

function labelsForApproval(block: Block, cwd: string): { label: string; tool: string } {
  let facts = approvalLabels.get(block);
  if (!facts || facts.cwd !== cwd) {
    facts = {
      cwd,
      label: toolCallLabel(block, cwd),
      tool: block.tool?.name ? humanName(block.tool.name) : "a tool",
    };
    approvalLabels.set(block, facts);
  }
  return facts;
}

export function approvalToastNotice(session: Session, previous?: ApprovalToastNotice): ApprovalToastNotice | null {
  const block = session.blocks[pendingApprovalIndex(session.blocks)];
  if (!block?.approval) return null;
  const { label, tool } = labelsForApproval(block, session.cwd);
  const requestId = block.approval.requestId;
  const choices = block.approval.choices;
  const title = sessionDisplayTitle(session.title, session.harness);
  if (previous && previous.sessionId === session.id && previous.requestId === requestId && previous.label === label && previous.tool === tool && previous.title === title && previous.choices === choices) return previous;
  return { sessionId: session.id, requestId, label, tool, title, ...(choices ? { choices } : {}) };
}

/** Latest undecided approval in a session, if any. */
export function pendingApprovalForSession(
  session: Session,
): PendingApprovalNotice | null {
  const block = session.blocks[pendingApprovalIndex(session.blocks)];
  if (!block?.approval) return null;
  const { label, tool } = labelsForApproval(block, session.cwd);
  return { sessionId: session.id, requestId: block.approval.requestId, label, tool, block };
}

// The store's pending-approval index reads approvals through this module.
sessionStore.setApprovalNoticeBuilder(approvalToastNotice);
