import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { onAwayPush, startAway } from "../lib/away";
import { workSwitch } from "../lib/workSwitch";
import { shell } from "../stores/shell";
import { dialogsChunk, workOutboxChunk } from "../surfaces/chunks";
import type { AwayReport } from "../work/outbox/AwayList";
import { AWAY_RETURN_GATHER_MS, AWAY_RETURN_TOAST, createAwayReturn, returnLine, type AwayDecidedThread } from "./awayReturnModel";
import { loadToast } from "./toastSync";

/** The list rides the dialogs chunk, mounted only while open. */
const AwayReviewDialog = dialogsChunk.surface("AwayReviewDialog");
/** With Work on, the return is Work's list (work/outbox/AwayList.tsx): held, failed, decided, written. */
const AwayReturnWork = workOutboxChunk.surface("AwayReturnWork");

/** The toast waits a while: the person just came back to it. */
const RETURN_TOAST_MS = 8_000;

type Props = {
  /** Opens a thread the list names. */
  onOpen: (sessionId: string, environmentId: string) => void;
};

/**
 * Back from Away: one toast, "Decided without you in 4 threads", with
 * Review, which opens the list of those threads. Mounted once with the
 * app's toasts (App.tsx); nothing when no thread decided anything. While a
 * host has Work on, the toast is Work's ("Held 7, decided 4 without you"),
 * it stays until pressed, and Review opens Work's list (work/outbox).
 */
export function AwayReturn({ onOpen }: Props) {
  const [review, setReview] = useState<AwayDecidedThread[] | null>(null);
  const [work, setWork] = useState<AwayReport | null>(null);
  const open = useRef(onOpen);
  useLayoutEffect(() => {
    open.current = onOpen;
  });
  useEffect(() => {
    startAway();
    let settle: ReturnType<typeof setTimeout> | undefined;
    const gather = createAwayReturn(
      (threads, tallies) => {
        if (workSwitch.anyOn()) {
          // Peers' tallies land within the gather window: Work's list is read once, after it.
          clearTimeout(settle);
          settle = setTimeout(() => {
            const hosts = [...tallies].map(([environmentId, decided]) => ({ environmentId, decided }));
            void workOutboxChunk
              .load()
              .then((m) => m.gatherAway(hosts))
              .then((found) => {
                if (!found) return;
                // A toast that offers Review stays until pressed (docs/DESIGN.md "Back from Away").
                void loadToast().then((toast) =>
                  toast(found.line, { id: AWAY_RETURN_TOAST, duration: Infinity, action: { label: "Review", onClick: () => setWork(found.report) } }),
                );
              });
          }, AWAY_RETURN_GATHER_MS);
          return;
        }
        if (threads.length === 0) return;
        void loadToast().then((toast) =>
          toast(returnLine(threads.length), {
            id: AWAY_RETURN_TOAST,
            duration: RETURN_TOAST_MS,
            action: { label: "Review", onClick: () => setReview(threads) },
          }),
        );
      },
      Date.now,
      () => workSwitch.anyOn(),
    );
    const off = onAwayPush(gather);
    return () => {
      clearTimeout(settle);
      off();
    };
  }, []);
  if (work) {
    return (
      <AwayReturnWork
        report={work}
        onClose={() => setWork(null)}
        onOpenSession={(sessionId, environmentId) => {
          setWork(null);
          open.current(sessionId, environmentId);
        }}
        onOpenOutbox={() => {
          setWork(null);
          shell.openOutbox();
        }}
      />
    );
  }
  if (!review) return null;
  return (
    <AwayReviewDialog
      threads={review}
      onOpen={(sessionId, environmentId) => open.current(sessionId, environmentId)}
      onClose={() => setReview(null)}
    />
  );
}
