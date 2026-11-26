import { useEffect, useState } from "react";
import { BusyLabel, Button } from "../../components/ui/button";
import { StatusMark } from "../../components/ui/status";
import { loadToast } from "../../components/ui/toaster";
import { Clock } from "../../chrome/icons";
import { storeTitleOf } from "../../lib/threadMentions";
import { useSlowClock } from "../../lib/turnClock";
import { workErrorWords } from "../../lib/workErrorWords";
import { ActView } from "../acts/ActView";
import { DetailFacts } from "./HeldDetail";
import { lifeosWords, timeOf } from "./model";
import { OfferLine } from "./OfferLine";
import { DetailColumn, itemTitle, KeptPicture, splitSummary, usePicture, VerbBar } from "./parts";
import { pressFailWords } from "./failWords";
import { loadResults, undoResult, useResults } from "./results";
import { readDetailResults, type HostItem, type HostOffer } from "./store";
import { decidedAt, whoWords } from "./waiting";

const toast = (line: string) => void loadToast().then((t) => t(line));
const toastError = (line: string) => void loadToast().then((t) => t.error(line));

/**
 * One item in Done: where, when and who decided over its title in the past;
 * what he discarded says why he gave the thread, what went out of date says
 * why; then the thing as it went, a computer act's picture, the grant it
 * earned, and its way back where its Result keeps one.
 */
export function DoneDetail({
  item,
  offer: listed,
  workspace,
  grantLabel,
  onOpenSession,
}: {
  item: HostItem;
  offer: HostOffer | null;
  workspace: string;
  grantLabel: string | null;
  onOpenSession?: (sessionId: string, environmentId: string) => void;
}) {
  const picture = usePicture(item);
  // The offer stays on screen once shown, so taking it can say so (with Undo) after the host stops listing it.
  const [offer, setOffer] = useState<HostOffer | null>(listed);
  useEffect(() => {
    if (listed) setOffer(listed);
  }, [listed]);
  const went = item.state === "sent";
  // The act's Result carries its way back (work_results); a mail has none.
  // Its way back comes with the detail's one ask (store.ts `fetchDetail`), or from the Results already held.
  useEffect(() => {
    if (went) readDetailResults(item);
  }, [went, item]);
  const results = useResults(item.environmentId, item.sessionId ?? "", false);
  const result = results.rows.find((r) => {
    const held = (r.ref as { held?: { at: string; id: string } } | null)?.held;
    return held?.at === item.ref.at && held.id === item.ref.id;
  });
  const [busy, setBusy] = useState(false);
  // Stored sent, but LifeOS has not said it went: said as it waits there, its age growing, with nothing about taking it back.
  const now = useSlowClock(went && item.lifeos === "queued") || Date.now();
  const queued = lifeosWords(item, now);
  const who = whoWords(item, { grantLabel, threadTitle: item.sessionId ? storeTitleOf(item.sessionId) : null });
  const back = async () => {
    if (!result) return;
    setBusy(true);
    try {
      await undoResult(result);
      toast(`${result.undo?.label ?? "Undone"}: ${splitSummary(item.summary).about ?? item.summary}`);
    } catch (err) {
      toastError(pressFailWords(err, "It was not taken back"));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <DetailColumn>
        <header className="flex flex-col">
          <DetailFacts item={item} job={workspace} when={timeOf(decidedAt(item))} onOpenSession={onOpenSession} extra={item.state === "stale" ? null : who} />
          <h1 className="mt-1 text-base font-semibold leading-6 tracking-[-0.01em] text-balance">{itemTitle(item, went && !queued)}</h1>
        </header>
        <div className="mt-3 flex flex-col gap-2 empty:hidden">
          {queued ? (
            <p role="status" className="text-[13px] leading-5">
              <StatusMark state={queued.state} word={queued.word} detail={queued.detail ?? undefined} />
            </p>
          ) : null}
          {item.state === "discarded" ? (
            <p className="max-w-[60ch] text-[13px] leading-5 text-muted-foreground">{item.reason ? `Discarded. You told the thread: “${item.reason}”` : "Discarded"}</p>
          ) : null}
          {item.state === "stale" ? (
            <p className="flex max-w-[60ch] items-start gap-2 text-[13px] leading-5 text-muted-foreground">
              <span className="flex h-5 w-3.5 shrink-0 items-center justify-center">
                <Clock className="size-3.5" />
              </span>
              <span>Out of date. {workErrorWords(item.error ?? "") || "It changed after it was made."}</span>
            </p>
          ) : null}
        </div>
        <div className="mt-5 flex flex-col gap-4">
          <ActView item={item} env={item.environmentId} />
          {item.kind === "computer.act" ? <KeptPicture item={item} picture={picture} /> : null}
          {offer ? <OfferLine offer={offer} /> : null}
        </div>
      </DetailColumn>
      {/* Only what went has a way back to say; a send LifeOS still holds has nothing to take back yet. */}
      {!went || (queued && !result && !(results.loaded && results.error)) ? null : (
        <VerbBar>
          <span className="flex-1" />
          {!results.loaded ? null : results.error && !result ? (
            <>
              <span className="min-w-0 truncate text-[13px] text-destructive">{workErrorWords(results.error) || "Its way back did not load"}</span>
              <Button variant="ghost" size="sm" disabled={results.reading} onClick={() => loadResults(item.environmentId, item.sessionId ?? "")}>
                <BusyLabel busy={results.reading} label="Retry" />
              </Button>
            </>
          ) : result?.undoneAt ? (
            <span className="text-[13px] text-muted-foreground">Taken back at {timeOf(result.undoneAt)}</span>
          ) : result?.undo ? (
            <Button variant="secondary" size="sm" disabled={busy} onClick={() => void back()}>
              <BusyLabel busy={busy} label={result.undo.label ?? "Undo"} />
            </Button>
          ) : queued ? null : (
            <span className="text-[13px] text-muted-foreground">{item.kind === "mail.send" || item.kind === "office.mail.send" ? "Sent mail cannot be taken back" : "This cannot be taken back"}</span>
          )}
        </VerbBar>
      )}
    </>
  );
}
