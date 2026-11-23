import type { SearchAnswer } from "@shared/work/search";
import type { AskedHost } from "./hosts";
import { begin, emptyModel, failed, landInstant, landSource, NETWORK_WAIT_MS, paramsFor, point, step, type Row, type SearchModel } from "./model";

/**
 * The search as it runs (docs/agents/work-search.md "The window"): the
 * model, and the asks that fill it. Every change of his words asks each
 * host at once for what it knows without the network; the sources a host
 * names are asked one by one, 120 ms after his last key, so each lands when
 * it is ready and one slow source holds up no other. An answer for words
 * he has since changed is dropped.
 */
export interface ControllerDeps {
  ask(hostId: string, params: Record<string, unknown>): Promise<SearchAnswer>;
  now(): number;
  later(run: () => void, ms: number): () => void;
}

export class SearchController {
  model: SearchModel = emptyModel();
  private listeners = new Set<() => void>();
  private waits: (() => void)[] = [];

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

  /** A new generation: his words, the kind, the hosts, and the job it is held to (its key; null: all jobs). */
  search(text: string, kind: string | null, hosts: AskedHost[], offline: readonly string[] = [], scope: string | null = null): void {
    for (const cancel of this.waits.splice(0)) cancel();
    this.set(begin(this.model, { text, kind, scope, hosts, offline }));
    const gen = this.model.gen;
    const typedAt = this.deps.now();
    for (const host of hosts) {
      this.deps.ask(host.id, paramsFor(this.model, host, { workspaceId: host.workspaceId })).then(
        (answer) => {
          const { model, ask } = landInstant(this.model, gen, host.id, answer);
          this.set(model);
          if (ask.length === 0 || gen !== this.model.gen) return;
          const go = (): void => {
            if (gen !== this.model.gen) return;
            for (const one of ask) {
              this.deps.ask(host.id, paramsFor(this.model, host, { workspaceId: host.workspaceId, sources: [one.source] })).then(
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
  }

  step(rows: readonly Row[], by: 1 | -1): void {
    this.set(step(this.model, rows, by));
  }
  point(id: string): void {
    this.set(point(this.model, id));
  }

  /** The picker closed: nothing still waiting is asked. An answer on its way lands on a model nobody reads. */
  close(): void {
    for (const cancel of this.waits.splice(0)) cancel();
  }
}

export const liveDeps = (ask: ControllerDeps["ask"]): ControllerDeps => ({
  ask,
  now: () => performance.now(),
  later(run, ms) {
    const timer = setTimeout(run, ms);
    return () => clearTimeout(timer);
  },
});
