import { useMemo, useRef, useSyncExternalStore } from "react";
import { Button } from "@renderer/components/ui/button";
import type { ApprovalDecision } from "../lib/harness";
import type { ApprovalToastNotice } from "../lib/approvalToast";
// Loaded for its side effect: it gives the store the builder its pending-approval index reads.
import "../lib/approvalToast";
import { seatedSession, subscribeToastAnchor } from "../lib/toastAnchor";
import { useToastSync } from "./toastSync";
import { HeldTip } from "../components/heldTip";
import { hostsHeld } from "./hostOffline";
import { TOAST_ACTION, TOAST_CANCEL } from "../components/ui/toaster";
import { registry, useEnvironmentStatuses } from "../lib/connection";
import { approveElsewhere, linkMay } from "../lib/linkMayCore";
import { sessionStore, usePendingApprovals } from "../lib/tcserver/store";

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

/** Why a toast's presses wait: its host away (the link's words), or a key that may not approve (who can). */
export function approvalHeldFor(environmentId: string | undefined): string | null {
  if (!environmentId) return null;
  if (!linkMay(environmentId, "session.approve")) return approveElsewhere(registry.environment(environmentId)?.name ?? environmentId);
  return hostsHeld([environmentId]);
}

/** Toasts for approvals pending in threads not on screen. The thread on
 *  screen is the one whose footer holds the toast stack (focused pane, shown
 *  tab, no page over the board): its card asks there, wherever the focus is.
 *  Subscribes to the store itself so App does not re-render per push. */
export function HiddenApprovalToasts(rest: Omit<Props, "notices">) {
  const onScreen = useSyncExternalStore(subscribeToastAnchor, seatedSession, () => null);
  const pending = usePendingApprovals();
  // One subscription to every host's link: a toast whose thread's host is away holds its presses (D5, edges-04).
  const statuses = useEnvironmentStatuses();
  const notices = useMemo(
    () =>
      [...pending.values()]
        .filter((notice) => notice.sessionId !== onScreen)
        .map((notice) => ({ ...notice, held: approvalHeldFor(sessionStore.environmentOf(notice.sessionId)) })),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- statuses is the cue to read the links again
    [pending, onScreen, statuses],
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
    (toast, { sessionId, title, label, requestId, choices, held }, id) => {
      const runSkip = choices === "run-skip";
      const allow = runSkip ? "Run now" : "Allow";
      const deny = runSkip ? "Skip" : "Deny";
      toast.warning(
        <Button variant="link" className="h-auto p-0 font-medium" onClick={() => actions.current.onFocusSession(sessionId)}>
          {title}
        </Button>,
        {
          id,
          description: label,
          duration: Infinity,
          ...(held
            ? {
                // Held: the same pair, disabled, one tooltip the host's state; the toast stays until it is answered.
                // sonner merges an update into the toast it replaces, so the live pair's cancel is cleared by name.
                cancel: undefined,
                action: (
                  <HeldTip held={held}>
                    <span data-held-approval className="ms-auto flex shrink-0 items-center gap-2">
                      <button type="button" disabled className={TOAST_CANCEL}>{deny}</button>
                      <button type="button" disabled className={TOAST_ACTION}>{allow}</button>
                    </span>
                  </HeldTip>
                ),
              }
            : {
                action: { label: allow, onClick: () => actions.current.onApproval(sessionId, requestId, "allow") },
                cancel: { label: deny, onClick: () => actions.current.onApproval(sessionId, requestId, "deny") },
              }),
        },
      );
    },
    (notice) => JSON.stringify([notice.title, notice.label, notice.choices ?? null, notice.held ?? null]),
  );
  return null;
}
