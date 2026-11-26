import { useMemo, useRef, useSyncExternalStore } from "react";
import { Button } from "@renderer/components/ui/button";
import type { ApprovalDecision } from "../lib/harness";
import type { ApprovalToastNotice } from "../lib/approvalToast";
// Loaded for its side effect: it gives the store the builder its pending-approval index reads.
import "../lib/approvalToast";
import { usePendingApprovals } from "../lib/tcserver/store";
import { seatedSession, subscribeToastAnchor } from "../lib/toastAnchor";
import { useToastSync } from "./toastSync";

type Notice = ApprovalToastNotice;

type Props = {
  notices: Notice[];
  onFocusSession: (sessionId: string) => void;
  onApproval: (
    sessionId: string,
    requestId: string | number,
    decision: ApprovalDecision,
  ) => void;
};

/** Toasts for approvals pending in threads not on screen. The thread on
 *  screen is the one whose footer holds the toast stack (focused pane, shown
 *  tab, no page over the board): its card asks there, wherever the focus is.
 *  Subscribes to the store itself so App does not re-render per push. */
export function HiddenApprovalToasts(rest: Omit<Props, "notices">) {
  const onScreen = useSyncExternalStore(subscribeToastAnchor, seatedSession, () => null);
  const pending = usePendingApprovals();
  const notices = useMemo(
    () => [...pending.values()].filter((notice) => notice.sessionId !== onScreen),
    [pending, onScreen],
  );
  return <ApprovalToasts notices={notices} {...rest} />;
}

/** One sonner toast per pending approval, held until it is answered: the
 *  thread's title opens it, Allow and Deny (Run now and Skip for a computer
 *  step waiting for the Mac) answer it. */
export function ApprovalToasts({ notices, onFocusSession, onApproval }: Props) {
  const actions = useRef({ onFocusSession, onApproval });
  actions.current = { onFocusSession, onApproval };
  useToastSync(
    notices,
    (notice) => `approval:${notice.sessionId}:${notice.requestId}`,
    (toast, { sessionId, title, label, requestId, choices }, id) => {
      const runSkip = choices === "run-skip";
      toast.warning(
        <Button variant="link" className="h-auto p-0 font-medium" onClick={() => actions.current.onFocusSession(sessionId)}>
          {title}
        </Button>,
        {
          id,
          description: label,
          duration: Infinity,
          action: { label: runSkip ? "Run now" : "Allow", onClick: () => actions.current.onApproval(sessionId, requestId, "allow") },
          cancel: { label: runSkip ? "Skip" : "Deny", onClick: () => actions.current.onApproval(sessionId, requestId, "deny") },
        },
      );
    },
    (notice) => JSON.stringify([notice.title, notice.label, notice.choices ?? null]),
  );
  return null;
}
