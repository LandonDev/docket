import { useState } from "react";
import type { AwayDecided } from "@shared/away";
import { BusyLabel, Button } from "../../components/ui/button";
import { DialogFooter } from "../../chrome/ConfirmDialog";
import { Modal, ModalBody } from "../../chrome/Modal";
import { StatusMark } from "../../components/ui/status";
import { TruncateTip } from "../../components/tip";
import { loadToast } from "../../components/ui/toaster";
import { SectorDot } from "../../chrome/WorkspaceGlyph";
import { useEnvironments } from "../../lib/connection";
import { workSwitch } from "../../lib/workSwitch";
import { storeTitleOf } from "../../lib/threadMentions";
import { useWorkspaces } from "../../lib/tcserver/workspaces";
import { AWAY_HEADING, awayLine, awaySections, byWorkspace, spanWords, WORK_CHATS_KEY, type AwayCounts } from "./model";
import { resultsSince, undoResult, type HostResult } from "./results";
import { loadHost, outboxNow, useOutbox, type HostItem } from "./store";
import { splitSummary } from "./OutboxView";

/** One host's tally of the stretch, as its Away push carried it. */
export type AwayHost = { environmentId: string; decided: AwayDecided };
export type AwayDecidedRow = { environmentId: string; sessionId: string; count: number };

/** What the return lists, collected from each host and merged here. */
export type AwayReport = {
  since: number;
  until: number;
  /** what still waits: the Outbox's own list, read live */
  held: number;
  failed: number;
  decided: AwayDecidedRow[];
  /** writes made while he was away (`work_results` since Away began), sends left out: they are in Sent */
  written: HostResult[];
};

const isSend = (r: HostResult): boolean => !!(r.ref as { held?: unknown } | null)?.held;

/**
 * Each host's part of the return (docs/agents/work-outbox.md, "Back from
 * Away"): its Outbox read afresh, and its writes since its own stretch
 * began. A host that does not answer is left out of the list, not waited on.
 */
export async function gatherAway(hosts: readonly AwayHost[], now = Date.now()): Promise<{ report: AwayReport; line: string } | null> {
  // One stretch for every host: the latest start any of them reports. A peer that missed the flip still holds an
  // older stretch's start (or 0), and its writes from before this one are not "while you were away".
  const since = Math.max(0, ...hosts.map((h) => h.decided.since));
  const parts = await Promise.all(
    hosts.map(async (h) => {
      if (!workSwitch.hosts().has(h.environmentId)) return [];
      const [, written] = await Promise.all([loadHost(h.environmentId), since > 0 ? resultsSince(h.environmentId, since).catch(() => [] as HostResult[]) : Promise.resolve([] as HostResult[])]);
      return written.filter((r) => !isSend(r));
    }),
  );
  const waiting = outboxNow().waiting;
  const failed = waiting.filter((i) => i.state === "failed").length;
  const held = waiting.length - failed;
  const decided = hosts.flatMap((h) => h.decided.threads.filter((t) => t.count > 0).map((t) => ({ environmentId: h.environmentId, sessionId: t.sessionId, count: t.count })));
  const counts: AwayCounts = { held, failed, decided: decided.reduce((n, d) => n + d.count, 0), written: parts.flat().length };
  const line = awayLine(counts);
  if (!line) return null;
  return { report: { since: since || now, until: now, held, failed, decided, written: parts.flat() }, line };
}

const toastError = (err: unknown) => void loadToast().then((t) => t.error(err instanceof Error ? err.message : String(err)));

/**
 * The list behind the return toast's Review (docs/DESIGN.md "Back from
 * Away": held items are the Outbox's): one dialog whose sections come in the
 * order he must act. Held is each workspace and how many wait there, Failed
 * each act that did not go and why; neither is sent from here, so a send that
 * may have gone keeps the Outbox's own guard. Decided is each thread with its
 * count and Open, Written each write with its way back. Held and failed are
 * read live from the Outbox; Open the Outbox sits at the footer's start.
 */
export function AwayReturnWork({
  report,
  onClose,
  onOpenSession,
  onOpenOutbox,
}: {
  report: AwayReport;
  onClose: () => void;
  onOpenSession: (sessionId: string, environmentId: string) => void;
  onOpenOutbox: () => void;
}) {
  const outbox = useOutbox();
  const workspaces = useWorkspaces();
  const environments = useEnvironments();
  const held = outbox.waiting.filter((i) => i.state !== "failed");
  const failed = outbox.waiting.filter((i) => i.state === "failed");
  const counts: AwayCounts = { held: held.length, failed: failed.length, decided: report.decided.length, written: report.written.length };
  const nameOf = (environmentId: string, workspaceId: string | null) =>
    !workspaceId || workspaceId === WORK_CHATS_KEY ? "Work Chats" : (workspaces.find((w) => w.environmentId === environmentId && w.id === workspaceId)?.name ?? "A Work workspace");
  const hostOf = (environmentId: string) => (environments.length > 1 ? environments.find((e) => e.id === environmentId)?.name : undefined);
  return (
    <Modal onClose={onClose} title="While you were away" description={spanWords(report.since, report.until)}>
      <ModalBody className="gap-4">
        {awaySections(counts).length === 0 ? <p className="text-[13px] text-muted-foreground">Everything here is done.</p> : null}
        {awaySections(counts).map((section) => (
          <section key={section} aria-label={AWAY_HEADING[section]} className="flex flex-col">
            <h2 className="flex h-7 items-center text-xs font-medium text-muted-foreground">{AWAY_HEADING[section]}</h2>
            {section === "held"
              ? byWorkspace(held).map((group) => (
                  <Row
                    key={group.key}
                    media={<SectorDot sector={group.sector} />}
                    title={nameOf(group.items[0]!.environmentId, group.workspaceId)}
                    line={heldWords(group.items)}
                  />
                ))
              : section === "failed"
                ? failed.map((item) => <Row key={`${item.environmentId}:${item.ref.id}`} title={splitSummary(item.summary).act} line={item.error ?? "It couldn't be sent"} tone="failed" />)
                : section === "decided"
                  ? report.decided.map((d) => (
                      <Row
                        key={`${d.environmentId}:${d.sessionId}`}
                        title={storeTitleOf(d.sessionId) ?? "A thread"}
                        line={[`${d.count} ${d.count === 1 ? "decision" : "decisions"}`, hostOf(d.environmentId)].filter(Boolean).join(", ")}
                      >
                        <Button variant="ghost" size="xs" onClick={() => onOpenSession(d.sessionId, d.environmentId)}>
                          Open
                        </Button>
                      </Row>
                    ))
                  : report.written.map((r) => <WrittenRow key={r.id} row={r} />)}
          </section>
        ))}
      </ModalBody>
      <DialogFooter
        start={
          counts.held || counts.failed ? (
            <Button variant="ghost" onClick={onOpenOutbox}>
              Open the Outbox
            </Button>
          ) : undefined
        }
        confirmLabel="Done"
        onConfirm={onClose}
        closeOnConfirm
      />
    </Modal>
  );
}

/** "2 mails waiting", or "3 waiting" across kinds: what a workspace holds, said once; the acts themselves are the Outbox's. */
export function heldWords(items: readonly Pick<HostItem, "kind">[]): string {
  const mail = items.every((i) => i.kind === "mail.send" || i.kind === "office.mail.send");
  return mail ? `${items.length} ${items.length === 1 ? "mail" : "mails"} waiting` : `${items.length} waiting`;
}

function Row({ title, line, tone, media, children }: { title: string; line?: string | null; tone?: "failed"; media?: React.ReactNode; children?: React.ReactNode }) {
  return (
    <div className="flex min-h-10 min-w-0 items-center gap-3 border-t border-border py-1.5 first-of-type:border-t-0">
      {tone ? <StatusMark state="failed" word={false} /> : media ? <span className="flex size-3.5 shrink-0 items-center justify-center">{media}</span> : null}
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-[13px] leading-5">{title}</span>
        {line ? (
          // A line cut short says the rest on hover: a failed act's reason is this list's whole point.
          <TruncateTip text={line}>
            <span data-row-line="" className={tone ? "truncate text-xs leading-4 text-destructive" : "truncate text-xs leading-4 text-muted-foreground"}>
              {line}
            </span>
          </TruncateTip>
        ) : null}
      </span>
      {children ? <span className="flex shrink-0 items-center">{children}</span> : null}
    </div>
  );
}

function WrittenRow({ row }: { row: HostResult }) {
  const [busy, setBusy] = useState(false);
  const [undone, setUndone] = useState(!!row.undoneAt);
  const undo = async () => {
    setBusy(true);
    try {
      await undoResult(row);
      setUndone(true);
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Row title={row.summary} line={row.account}>
      {undone ? (
        <span className="text-xs text-muted-foreground">Undone</span>
      ) : row.undo ? (
        <Button variant="ghost" size="xs" disabled={busy} onClick={() => void undo()}>
          <BusyLabel busy={busy} label={row.undo.label ?? "Undo"} />
        </Button>
      ) : null}
    </Row>
  );
}
