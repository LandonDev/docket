import type { SearchAnswer } from "@shared/work/search";
import type { AskedHost } from "./hosts";
import { begin, emptyModel, failed, landInstant, landSource, NETWORK_WAIT_MS, paramsFor, point, step, type Row, type SearchModel } from "./model";

/**
 * The search as it runs (docs/agents/work-search.md "The window"): the
 * model, and the asks that fill it. His words ask each host for what it
 * knows without the network: at once for a key after a pause, else
 * `TYPE_WAIT_MS` after his last key, so a run of keys asks once more at its
 * end rather than once a key. The sources a host names are asked one by one,
 * 120 ms after his last key, so each lands when it is ready and one slow
 * source holds up no other. New words drop every ask still waiting and abort
 * the ones out (their answers are dropped too).
 */
export const TYPE_WAIT_MS = 70;

export interface ControllerDeps {
  /** `signal`: aborted once newer words replace the ask's */
  ask(hostId: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<SearchAnswer>;
  now(): number;
  later(run: () => void, ms: number): () => void;
}

export class SearchController {
  model: SearchModel = emptyModel();
  private listeners = new Set<() => void>();
  private waits: (() => void)[] = [];
  /** the picker closed since the last search began */
  private closed = false;
  /** when his words last changed, and the asks of those words */
  private typedAt: number | null = null;
  private typedText: string | null = null;
  private asking: AbortController | null = null;

  constructor(private readonly deps: ControllerDeps) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };
  read = (): SearchModel => this.model;

  private set(next: SearchModel): void {
    if (next === this.model) return;
    this.model = next;
    for (const listener of [...this.listeners]) listener();
  }

  /** A new generation: his words, the kind, the hosts, and the job it is held to (its key and its workspaces; null: all jobs). */
  search(text: string, kind: string | null, hosts: AskedHost[], offline: readonly string[] = [], scope: string | null = null, within: readonly string[] | null = null, unsearched: string | null = null): void {
    for (const cancel of this.waits.splice(0)) cancel();
    // The asks of the words these replace: stopped.
    this.asking?.abort();
    const asking = (this.asking = new AbortController());
    this.closed = false;
    this.set(begin(this.model, { text, kind, scope, within, hosts, offline, unsearched }));
    const gen = this.model.gen;
    const typedAt = this.deps.now();
    // A key right after another waits for the next: only the run's last words are asked. No words (what he opened
    // last, asked as the picker opens) start no run, and the same words asked again (another kind, another job, a
    // press) are asked at once.
    const typed = text !== this.typedText;
    const quick = typed && this.typedAt !== null && typedAt - this.typedAt < TYPE_WAIT_MS;
    if (typed) this.typedAt = text.trim() ? typedAt : null;
    this.typedText = text;
    const askAll = (): void => {
      if (gen !== this.model.gen || this.closed) return;
      for (const host of hosts) this.askHost(host, gen, typedAt, asking.signal);
    };
    if (quick) this.waits.push(this.deps.later(askAll, TYPE_WAIT_MS));
    else askAll();
  }

  private askHost(host: AskedHost, gen: number, typedAt: number, signal: AbortSignal): void {
    this.deps.ask(host.id, paramsFor(this.model, host, { workspaceId: host.workspaceId }), signal).then(
      (answer) => {
        const { model, ask } = landInstant(this.model, gen, host.id, answer);
        this.set(model);
        // Closed while the first ask was out: nothing more is asked of anyone.
        if (ask.length === 0 || gen !== this.model.gen || this.closed) return;
        const go = (): void => {
          if (gen !== this.model.gen) return;
          for (const one of ask) {
            this.deps.ask(host.id, paramsFor(this.model, host, { workspaceId: host.workspaceId, sources: [one.source] }), signal).then(
              (found) => this.set(landSource(this.model, gen, host.id, one.source, found)),
              () => this.set(failed(this.model, gen, host.id, one)),
            );
          }
        };
        const wait = NETWORK_WAIT_MS - (this.deps.now() - typedAt);
        if (wait <= 0) go();
        else this.waits.push(this.deps.later(go, wait));
      },
      () => this.set(failed(this.model, gen, host.id, null)),
    );
  }

  step(rows: readonly Row[], by: 1 | -1): void {
    this.set(step(this.model, rows, by));
  }
  point(id: string): void {
    this.set(point(this.model, id));
  }

  /** The picker closed: nothing still waiting is asked. An answer on its way lands on a model nobody reads. */
  close(): void {
    this.closed = true;
    for (const cancel of this.waits.splice(0)) cancel();
    this.asking?.abort();
    this.typedAt = null;
    this.typedText = null;
  }
}

export const liveDeps = (ask: (hostId: string, params: Record<string, unknown>) => Promise<SearchAnswer>): ControllerDeps => ({
  // The wire has no cancel for one ask: an aborted one is let go here, its answer never read.
  ask: (hostId, params, signal) =>
    signal?.aborted
      ? Promise.reject(new Error("replaced"))
      : new Promise((resolve, reject) => {
          const off = (): void => reject(new Error("replaced"));
          signal?.addEventListener("abort", off, { once: true });
          ask(hostId, params).then(resolve, reject).finally(() => signal?.removeEventListener("abort", off));
        }),
  now: () => performance.now(),
  later(run, ms) {
    const timer = setTimeout(run, ms);
    return () => clearTimeout(timer);
  },
});
