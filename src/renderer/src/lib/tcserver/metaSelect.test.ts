import { describe, expect, it } from "vitest";
import { metasDerived, metasWhere, sameItems } from "./metaSelect";
import type { MetaChanges, sessionStore } from "./store";
import type { SessionMeta } from "./types";

/** The store's public parts the selectors read, held in a map. */
function fakeStore(metas: SessionMeta[]) {
  let rows = metas;
  let snapshot: SessionMeta[] = rows;
  const listeners = new Set<(c: MetaChanges) => void>();
  const store = {
    metas: () => snapshot,
    metaOf: (id: string) => rows.find((m) => m.id === id) ?? null,
    childrenOf: (id: string) => rows.filter((m) => m.parentId === id),
    onMetaChange: (l: (c: MetaChanges) => void) => (listeners.add(l), () => listeners.delete(l)),
  };
  const push = (m: SessionMeta) => {
    rows = rows.some((x) => x.id === m.id) ? rows.map((x) => (x.id === m.id ? m : x)) : [...rows, m];
    snapshot = [...rows];
    for (const l of listeners) l({ ids: new Set([m.id]), affected: new Set([m.id, ...(m.parentId ? [m.parentId] : [])]) });
  };
  return { store: store as unknown as typeof sessionStore, push };
}

const meta = (id: string, over: Partial<SessionMeta> = {}) => ({ id, parentId: null, projectId: "p1", status: "running", title: id, ...over }) as SessionMeta;

describe("metasWhere", () => {
  it("a push of a thread it does not hold costs one look at that id and tells no one", () => {
    const { store, push } = fakeStore([meta("a"), ...Array.from({ length: 300 }, (_, i) => meta(`x${i}`, { projectId: "p9" }))]);
    let looks = 0;
    const where = metasWhere((m) => (looks++, m.projectId === "p1"), store);
    // As React does: the render reads, then the commit subscribes.
    const first = where.read();
    let told = 0;
    const off = where.subscribe(() => told++);
    expect(first.map((m) => m.id)).toEqual(["a"]);
    looks = 0;
    for (let i = 0; i < 10; i++) push(meta("x5", { projectId: "p9", title: `moved ${i}` }));
    expect(looks).toBe(10);
    expect(told).toBe(0);
    expect(where.read()).toBe(first);
    push(meta("x5", { projectId: "p1" }));
    expect(told).toBe(1);
    expect(where.read().map((m) => m.id)).toEqual(["a", "x5"]);
    off();
  });
});

describe("metasDerived", () => {
  it("tells only when the derived value reads differently", () => {
    const { store, push } = fakeStore([meta("a"), meta("b")]);
    const derived = metasDerived((all) => all.filter((m) => m.status === "running").map((m) => m.id), sameItems, store);
    const first = derived.read();
    let told = 0;
    const off = derived.subscribe(() => told++);
    push(meta("b", { title: "moved" }));
    expect(told).toBe(0);
    expect(derived.read()).toBe(first);
    push(meta("b", { status: "idle" }));
    expect(told).toBe(1);
    expect(derived.read()).toEqual(["a"]);
    off();
  });
});
