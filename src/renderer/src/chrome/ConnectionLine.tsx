import { useEffect, useState } from "react";
import { identityChanged, linkWords, registry, useEnvironmentDegraded, useEnvironmentName, type Degraded, type EnvironmentStatus } from "../lib/connection";
import { Spinner } from "../components/ui/spinner";
import { BusyLabel, Button } from "../components/ui/button";
import { shell } from "../stores/shell";
import { computerPageOf } from "../lib/computerPage";
import { settingsChunk } from "../surfaces/chunks";

/**
 * One thin line above a thread's composer while the thread's host is not
 * reachable: what is wrong, the next retry, and the one action that helps.
 * The rows above stay as they were; only sending waits. Nothing shows for
 * a drop that comes back inside the grace period (lib/connection/degraded).
 */

/**
 * The reason a thread cannot take a message right now, or null. The text holds still (no countdown), so the
 * composer that reads it does not re-render once a second while a host reconnects; the seconds tick inside
 * `ConnectionLine` alone.
 */
export function useEnvironmentBlock(environmentId: string): { degraded: Degraded | null; name: string; text: string | null } {
  const degraded = useEnvironmentDegraded(environmentId);
  const name = useEnvironmentName(environmentId);
  return { degraded, name, text: degraded ? linkWords(name, degraded) : null };
}

/** The line's one action: a ghost button in the line's own 12px muted type,
 *  20px tall with its hit area stretched to 24px. */
const ACTION = "h-5 px-1.5 text-xs font-normal text-muted-foreground after:absolute after:inset-x-0 after:-inset-y-0.5 after:content-[''] hover:text-foreground";

export function ConnectionLine({ environmentId }: { environmentId: string }) {
  const degraded = useEnvironmentDegraded(environmentId);
  const name = useEnvironmentName(environmentId);
  const counting = degraded?.kind === "reconnecting" && degraded.status.nextRetryAt !== null;
  const [now, setNow] = useState(Date.now());
  // A press of Retry spins until the link's state moves on.
  const [pressed, setPressed] = useState<EnvironmentStatus | null>(null);
  useEffect(() => {
    if (!counting) return;
    setNow(Date.now());
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [counting, degraded?.status.nextRetryAt]);
  if (!degraded) return null;
  const retry = () => {
    setPressed(degraded.status);
    registry.retry(environmentId);
  };
  return <ConnectionLineView kind={degraded.kind} pair={identityChanged(degraded.status)} text={linkWords(name, degraded, now)} said={linkWords(name, degraded)} retrying={pressed === degraded.status} onRetry={retry} onPair={() => shell.openSettings(computerPageOf(environmentId))} />;
}

/** `text` is what the line shows (a countdown ticks in it); `said` the steady words announced once a state
 *  ("Reconnecting to the box…"), so a screen reader never hears the line again each second. The live region
 *  holds those words alone: Retry and Pair again are buttons of their own, outside it. */
export function ConnectionLineView({ kind, text, said = text, pair = false, retrying = false, onRetry, onPair }: { kind: Degraded["kind"]; text: string; said?: string; pair?: boolean; retrying?: boolean; onRetry: () => void; onPair: () => void }) {
  const unauthorized = kind === "unauthorized";
  return (
    // On the box row's 6px inset with its glyph on `+`'s 28px axis and its words on the field's.
    <div
      data-connection-line={kind}
      className="mb-2 flex min-h-6 items-center gap-1 px-1.5 text-xs text-muted-foreground"
    >
      <span aria-hidden className="flex w-7 shrink-0 justify-center">
        {unauthorized || kind === "offline" ? (
          <span className={`size-1.5 rounded-full ${unauthorized ? "bg-danger" : "bg-foreground/25"}`} />
        ) : (
          <Spinner aria-hidden className="size-3 text-muted-foreground" />
        )}
      </span>
      <span aria-hidden data-connection-words className="min-w-0 flex-1 px-1 text-pretty">{text}</span>
      <span role="status" className="sr-only">{said}</span>
      {unauthorized || pair ? (
        <Button variant="ghost" size="xs" {...settingsChunk.intent} onClick={onPair} className={`shrink-0 ${ACTION}`}>
          Pair again
        </Button>
      ) : kind !== "connecting" ? (
        <Button variant="ghost" size="xs" onClick={onRetry} disabled={retrying} className={`shrink-0 ${ACTION}`}>
          <BusyLabel busy={retrying} label="Retry" align="end" />
        </Button>
      ) : null}
    </div>
  );
}
