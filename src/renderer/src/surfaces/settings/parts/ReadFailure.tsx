import { createContext, useContext, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { PageError } from "../../../components/page";
import { BusyLabel, Button } from "../../../components/ui/button";
import { NO_ANSWER } from "../../../lib/connection/openRead";
import { computerInLine, useComputerName, useReadFailWords } from "../../../lib/settings/computerName";

/**
 * A read a page could not make (docs/agents/settings.md "When a computer does not answer"). On a Settings page every
 * failure is said at the page's head, under its title, once: the computers that did not answer on one line ("The box
 * and this Mac did not answer."), any other reason on its own, each line with one Retry that asks every read it
 * stands for again. In its section's place a failure draws nothing, so a section with nothing else hides its heading
 * (SettingSection). Every Settings page sits under one `FailuresSaidOnce` (SettingsView, the project sheet); outside
 * one, a failure says its own line where it stands.
 */

type Failure = { computer: string; own: boolean; silent: boolean; words: string; retry: () => unknown };

class Failures {
  private byId = new Map<string, Failure>();
  private listeners = new Set<() => void>();
  private version = 0;

  set(id: string, failure: Failure | null): void {
    const was = this.byId.get(id);
    if (failure ? was?.words === failure.words && was.computer === failure.computer && was.own === failure.own && was.retry === failure.retry : !was) return;
    // A Map keeps the order failures first said themselves: the page's lines follow it.
    if (failure) this.byId.set(id, failure);
    else this.byId.delete(id);
    this.version += 1;
    for (const listener of this.listeners) listener();
  }

  /** The page's lines: every computer that did not answer on one, then each other reason once. */
  lines(): { words: string; retries: (() => unknown)[] }[] {
    const silent: string[] = [];
    const silentRetries: (() => unknown)[] = [];
    const others = new Map<string, (() => unknown)[]>();
    // One order whichever read failed first: this window's own computer, then the others by name.
    const failures = [...this.byId.values()].sort((a, b) => Number(b.own) - Number(a.own) || a.computer.localeCompare(b.computer));
    for (const failure of failures) {
      if (failure.silent) {
        if (!silent.includes(failure.computer)) silent.push(failure.computer);
        silentRetries.push(failure.retry);
      } else others.set(failure.words, [...(others.get(failure.words) ?? []), failure.retry]);
    }
    const lines = silent.length ? [{ words: `${opening(listed(silent))} did not answer.`, retries: silentRetries }] : [];
    for (const [words, retries] of others) lines.push({ words, retries });
    return lines;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  snapshot = (): number => this.version;
}

const opening = (words: string): string => words.charAt(0).toUpperCase() + words.slice(1);
/** "the box", "the box and this Mac", "the box, this Mac and PURDUE-LT". */
const listed = (names: readonly string[]): string => (names.length < 2 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`);

const FailuresContext = createContext<Failures | null>(null);

/** One page's failures, said at its head once each; `head={false}` where the page puts `FailureLinesHere` itself (a
 *  sheet, under its own title). */
export function FailuresSaidOnce({ children, head = true }: { children: ReactNode; head?: boolean }) {
  const failures = useMemo(() => new Failures(), []);
  return (
    <FailuresContext.Provider value={failures}>
      {head ? <FailureLines failures={failures} /> : null}
      {children}
    </FailuresContext.Provider>
  );
}

/** The page's failure lines, where a page that is not a Settings page puts them. */
export function FailureLinesHere() {
  const failures = useContext(FailuresContext);
  return failures ? <FailureLines failures={failures} /> : null;
}

function FailureLines({ failures }: { failures: Failures }) {
  useSyncExternalStore(failures.subscribe, failures.snapshot);
  const lines = failures.lines();
  if (!lines.length) return null;
  return (
    <div data-read-failures="" className="flex flex-col">
      {lines.map((line) => (
        <FailureLine key={line.words} words={line.words} retries={line.retries} />
      ))}
    </div>
  );
}

function FailureLine({ words, retries, className }: { words: string; retries: readonly (() => unknown)[]; className?: string }) {
  const [retrying, setRetrying] = useState(false);
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

/**
 * A failed read, in its section's place: `computer` is the environment id the read went to, `error` the read's own
 * reason (NO_ANSWER past the deadline becomes the computer's name). On a page it is said at the page's head and draws
 * nothing here; alone it says its own line. Retry spins until every read it asked has settled.
 */
export function ReadFailure({ computer, error, retry, className }: { computer: string; error: string; retry: () => unknown; className?: string }) {
  const failures = useContext(FailuresContext);
  const words = useReadFailWords(computer)(error);
  const name = useComputerName(computer);
  const inLine = computerInLine(name);
  const own = name.own;
  const silent = !error || error === NO_ANSWER;
  const id = useId();
  // The newest retry, through a stable function: a parent's new closure each render does not re-register.
  const latest = useRef(retry);
  useLayoutEffect(() => {
    latest.current = retry;
  });
  const stable = useMemo(() => () => latest.current(), []);
  useLayoutEffect(() => {
    failures?.set(id, { computer: inLine, own, silent, words, retry: stable });
    return () => failures?.set(id, null);
  }, [failures, id, inLine, own, silent, words, stable]);
  if (failures) return null;
  return <FailureLine words={words} retries={[retry]} className={className} />;
}
