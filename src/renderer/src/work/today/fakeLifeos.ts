import type { ConvexReactClient } from "convex/react";
import { getFunctionName, type FunctionReference } from "convex/server";
import type { SectorKey } from "@shared/work";
import { setLifeosSession, setLifeosStatus, type LifeosSession } from "../shell/lifeos";

/**
 * A LifeOS in memory for Today's tests and its live proof: a Convex client
 * whose live queries the test feeds and whose writes it records. Used by
 * nothing in the app.
 */
export class FakeConvex {
  /** Every write made, in order. */
  readonly writes: { name: string; args: Record<string, unknown> }[] = [];
  /** Every live query opened, in order. */
  readonly reads: { name: string; args: Record<string, unknown> }[] = [];
  private readonly answers = new Map<string, (args: Record<string, unknown>) => unknown>();
  private readonly mutations = new Map<string, (args: Record<string, unknown>) => unknown>();
  private readonly listeners = new Set<() => void>();

  /** What a query answers: a value, or a function of its args; `undefined` is still loading, and a thrown error is LifeOS's refusal. */
  answer(name: string, value: unknown | ((args: Record<string, unknown>) => unknown)): this {
    this.answers.set(name, typeof value === "function" ? (value as (args: Record<string, unknown>) => unknown) : () => value);
    for (const listener of [...this.listeners]) listener();
    return this;
  }

  /** What a write does and answers; one with none answers null. */
  onWrite(name: string, run: (args: Record<string, unknown>) => unknown): this {
    this.mutations.set(name, run);
    return this;
  }

  watchQuery(ref: FunctionReference<"query">, args: Record<string, unknown> = {}) {
    const name = getFunctionName(ref);
    this.reads.push({ name, args });
    return {
      localQueryResult: () => this.answers.get(name)?.(args),
      onUpdate: (listener: () => void) => {
        this.listeners.add(listener);
        return () => void this.listeners.delete(listener);
      },
    };
  }

  async mutation(ref: FunctionReference<"mutation">, args: Record<string, unknown> = {}): Promise<unknown> {
    const name = getFunctionName(ref);
    this.writes.push({ name, args });
    return this.mutations.get(name)?.(args) ?? null;
  }

  async close(): Promise<void> {}
}

/** A connected session on `environmentId` over a fake LifeOS, for all sectors or one; the host reads as connected. */
export function fakeSession(environmentId: string, convex: FakeConvex, sector: SectorKey | null = null): LifeosSession {
  const session: LifeosSession = { environmentId, sector, client: convex as unknown as ConvexReactClient, state: "connected" };
  setLifeosStatus(environmentId, { lifeos: { state: "connected", ownerId: "owner", since: 0 }, keys: [] });
  setLifeosSession(session);
  return session;
}
