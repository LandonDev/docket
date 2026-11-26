import { createContext, useContext, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { PageError } from "../../../components/page";
import { BusyLabel, Button } from "../../../components/ui/button";
import { useReadFailWords } from "../../../lib/settings/computerName";

/**
 * A read a page could not make, said once a page (docs/agents/settings.md "When a computer does not answer"): each
 * failure names its computer ("The box did not answer."), and where two reads on one page fail with the same words,
 * the first says it and its Retry asks both again; the second draws nothing. Every Settings page sits under one
 * `FailuresSaidOnce` (SettingsView); outside one, a failure says its own line.
 */

type Failure = { words: string; retry: () => unknown };

class Failures {
  private byId = new Map<string, Failure>();
  private listeners = new Set<() => void>();
  private version = 0;

  set(id: string, failure: Failure | null): void {
    const was = this.byId.get(id);
    if (failure ? was?.words === failure.words && was.retry === failure.retry : !was) return;
    // A Map keeps the order failures first said themselves: the first keeps the line.
    if (failure) this.byId.set(id, failure);
    else this.byId.delete(id);
    this.version += 1;
    for (const listener of this.listeners) listener();
  }

  /** The first failure with these words, and every retry that shares them. */
  lead(words: string): { id: string; retries: (() => unknown)[] } | null {
    let id: string | null = null;
    const retries: (() => unknown)[] = [];
    for (const [key, failure] of this.byId) {
      if (failure.words !== words) continue;
      id ??= key;
      retries.push(failure.retry);
    }
    return id ? { id, retries } : null;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  snapshot = (): number => this.version;
}

const FailuresContext = createContext<Failures | null>(null);

/** One page's failures, said once each. */
export function FailuresSaidOnce({ children }: { children: ReactNode }) {
  const failures = useMemo(() => new Failures(), []);
  return <FailuresContext.Provider value={failures}>{children}</FailuresContext.Provider>;
}

/**
 * The line a failed read leaves in its section's place: `computer` is the environment id the read went to, `error`
 * the read's own reason (NO_ANSWER past the deadline becomes the computer's name). Draws nothing where an earlier
 * failure on the page already said the same words. Retry spins until every read it asked has settled.
 */
export function ReadFailure({ computer, error, retry, className }: { computer: string; error: string; retry: () => unknown; className?: string }) {
  const [retrying, setRetrying] = useState(false);
  const failures = useContext(FailuresContext);
  const words = useReadFailWords(computer)(error);
  const id = useId();
  // The newest retry, through a stable function: a parent's new closure each render does not re-register.
  const latest = useRef(retry);
  useLayoutEffect(() => {
    latest.current = retry;
  });
  const stable = useMemo(() => () => latest.current(), []);
  useLayoutEffect(() => {
    failures?.set(id, { words, retry: stable });
    return () => failures?.set(id, null);
  }, [failures, id, words, stable]);
  useSyncExternalStore(failures?.subscribe ?? noSubscribe, failures?.snapshot ?? zero);
  const lead = failures?.lead(words);
  if (lead && lead.id !== id) return null;
  const retries = lead?.retries ?? [retry];
  return (
    <PageError
      data-read-failure=""
      className={className}
      action={
        <Button
          variant="ghost"
          size="sm"
          disabled={retrying}
          onClick={() => {
            setRetrying(true);
            void Promise.allSettled(retries.map((again) => again())).finally(() => setRetrying(false));
          }}
        >
          <BusyLabel busy={retrying} label="Retry" />
        </Button>
      }
    >
      {words}
    </PageError>
  );
}

const noSubscribe = (): (() => void) => () => {};
const zero = (): number => 0;
