import type { DigestDay, DigestPush, DigestSettings } from "@shared/contract-work-digest";
import type { TellRow } from "@shared/work/tell";

/**
 * Two hosts that answer `work.digest.*` from memory, for the digest's DOM
 * tests: a test file mocks `lib/connection` with `connectionMock(world)`.
 */

export type Call = { env: string; method: string; params: Record<string, unknown> };
export interface World {
  calls: Call[];
  rows: Map<string, TellRow[]>;
  days: Map<string, DigestDay[]>;
  settings: Map<string, DigestSettings>;
  down: Set<string>;
  refuses: Set<string>;
  pushers: Map<string, Set<(push: DigestPush) => void>>;
}

export const makeWorld = (): World => ({ calls: [], rows: new Map(), days: new Map(), settings: new Map(), down: new Set(), refuses: new Set(), pushers: new Map() });

export const SETTINGS: DigestSettings = { at: "08:00", zone: "America/Chicago", levels: {}, nextAt: 0 };

export function resetWorld(world: World): void {
  world.calls.length = 0;
  world.rows.clear();
  world.days.clear();
  world.settings.clear();
  world.down.clear();
  world.refuses.clear();
}

export function linkOf(world: World, env: string) {
  return {
    environmentId: env,
    connected: true,
    onPush: (listener: (push: DigestPush) => void) => {
      const set = world.pushers.get(env) ?? new Set();
      set.add(listener);
      world.pushers.set(env, set);
      return () => void set.delete(listener);
    },
    onOpen: () => () => undefined,
    onClose: () => () => undefined,
    request: async (method: string, params: Record<string, unknown> = {}) => {
      world.calls.push({ env, method, params });
      if (world.down.has(env)) throw new Error("socket closed");
      switch (method) {
        case "work.digest.list":
          return { days: world.days.get(env) ?? [], rows: world.rows.get(env) ?? [], waiting: 0, groups: [] };
        case "work.digest.get":
          return world.settings.get(env) ?? SETTINGS;
        case "work.digest.set": {
          if (world.refuses.has(env)) throw new Error("forbidden: needs admin");
          const before = world.settings.get(env) ?? SETTINGS;
          const next = { ...before, ...(params.at ? { at: params.at as string } : {}), levels: { ...before.levels, ...((params.levels as object) ?? {}) } };
          world.settings.set(env, next);
          return next;
        }
        case "work.digest.seen":
          world.days.set(env, (world.days.get(env) ?? []).map((d) => (d.day === params.day ? { ...d, seenAt: d.seenAt ?? 77 } : d)));
          return null;
        case "work.digest.here":
          return null;
      }
      throw new Error(`unknown ${method}`);
    },
  };
}

/** What `vi.mock("../../lib/connection", …)` answers with, over the real module. */
export function connectionMock(world: World, real: object) {
  const links = { box: linkOf(world, "box"), mac: linkOf(world, "mac") };
  return {
    ...real,
    registry: {
      linkOf: (env: "box" | "mac") => links[env],
      onLink: (listener: (l: ReturnType<typeof linkOf>, event: string) => void) => {
        listener(links.box, "added");
        listener(links.mac, "added");
        return () => undefined;
      },
    },
    useEnvironments: () => [
      { id: "box", name: "The box", platform: "linux" },
      { id: "mac", name: "The Mac", platform: "darwin" },
    ],
  };
}

export const push = (world: World, env: string, p: Omit<DigestPush, "push">): void => {
  for (const listener of world.pushers.get(env) ?? []) listener({ push: "work.digest", ...p });
};

let n = 0;
export const tell = (over: Partial<TellRow> = {}): TellRow => ({
  id: `t${++n}`,
  host: "box",
  kind: "routines.done",
  group: "results",
  workspaceId: "ws-cosmic",
  sector: "cosmic",
  title: "Morning summary",
  at: new Date(2026, 10, 24, 7, 30).getTime(),
  how: "waiting",
  day: null,
  toldAt: null,
  ...over,
});
