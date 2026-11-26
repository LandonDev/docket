import { useState } from "react";
import { BusyLabel, Button } from "../../components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../../components/ui/empty";
import { Spinner } from "../../components/ui/spinner";
import { lifeosHostName } from "./lifeos";
import { downWords, useDownPress } from "./lifeosDown";
import type { LiveDown } from "./lifeosLive";
import { connectingWords } from "./lifeosWords";
import { useDownAction } from "./DownSignIn";

export { savedOfReason } from "./lifeosLive";

/**
 * A body with nothing to show while its host's LifeOS is down (`useLiveDown`: Files' LifeOS place, a canvas item that
 * did not open, `OpenFailed`): the state, said once in the body's place, with the computer named and the rule's one press.
 * Retry is the reader's own ask, for silence alone, and spins while it is out (`busy` also stands for the reader's own
 * read under way); Sign in and Show the code open the sign-in dialog in place where this window may sign that host in;
 * Open Settings for Work off where it may turn Work on; else who can. A session on its way is a wait: its words and a
 * spinner, no press. Draws nothing while LifeOS reads.
 */
export function DownEmpty({ live, environmentId, onRetry, busy = false }: { live: LiveDown; environmentId: string; onRetry(): void | Promise<void>; busy?: boolean }) {
  const [asking, setAsking] = useState(false);
  const { press, elsewhere } = useDownPress(live.down, environmentId);
  const retry = (): void => {
    setAsking(true);
    void Promise.resolve()
      .then(onRetry)
      .catch(() => undefined)
      .finally(() => setAsking(false));
  };
  const { action, dialog } = useDownAction(press, environmentId, retry);
  const host = lifeosHostName(environmentId);
  if (live.waits)
    return (
      <Empty data-lifeos-waits role="status" aria-busy>
        <EmptyMedia>
          <Spinner className="size-4" />
        </EmptyMedia>
        <EmptyHeader>
          {/* A wait, not a state to act on: muted, as every reader's wait line is (DESIGN "Loading and empty states"). */}
          <EmptyDescription>{connectingWords(host)}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  if (!live.down) return null;
  const spinning = press === "retry" && (asking || busy);
  return (
    <>
      <Empty data-lifeos-down={live.down}>
        <EmptyHeader>
          <EmptyTitle>{downWords(live.down, host)}</EmptyTitle>
          {elsewhere ? <EmptyDescription>{elsewhere}</EmptyDescription> : null}
        </EmptyHeader>
        {action ? (
          <Button size="sm" variant="secondary" disabled={spinning} onClick={action.run}>
            <BusyLabel busy={spinning} label={action.label} />
          </Button>
        ) : null}
      </Empty>
      {dialog}
    </>
  );
}
