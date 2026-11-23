import { describe, expect, it } from "vitest";
import type { SearchAnswer, SearchGroup } from "@shared/work/search";
import { SearchController } from "./controller";
import type { AskedHost } from "./hosts";
import { busy, rowsOf } from "./model";

/** The search as it runs: what is asked of whom and when, with a clock the test moves. */

const box: AskedHost = { id: "box", name: "The box", home: true };
const mac: AskedHost = { id: "mac", name: "MacBook", home: false, workspaceId: "mac-w" };
const group = (kind: string, keys: string[], source = `search.${kind}`): SearchGroup => ({ source, kind, label: kind, more: false, hits: keys.map((key) => ({ key, kind, title: `budget ${key}`, workspaceId: "w", open: { to: "view" as const, view: kind } })) });

function rig() {
  let now = 0;
  const asked: { host: string; params: Record<string, unknown>; answer(a: SearchAnswer): void; fail(): void }[] = [];
  const timers: { at: number; run(): void; off: boolean }[] = [];
  const controller = new SearchController({
    ask: (host, params) => new Promise((answer, fail) => void asked.push({ host, params, answer, fail: () => fail(new Error("gone")) })),
    now: () => now,
    later(run, ms) {
      const timer = { at: now + ms, run, off: false };
      timers.push(timer);
      return () => void (timer.off = true);
    },
  });
  const tick = async (ms = 0): Promise<void> => {
    now += ms;
    for (const timer of timers.filter((t) => !t.off && t.at <= now)) {
      timer.off = true;
      timer.run();
    }
    await Promise.resolve();
    await Promise.resolve();
  };
  const keys = (): string[] => rowsOf(controller.model).flatMap((row) => (row.type === "hit" ? [row.hit.key] : []));
  return { controller, asked, tick, keys };
}

describe("a search as it runs", () => {
  it("asks every host at once for what it knows without the network, each for its own job when held to one", async () => {
    const r = rig();
    r.controller.search("budget", null, [box, mac]);
    expect(r.asked.map((a) => [a.host, a.params])).toEqual([
      ["box", { text: "budget", tier: "instant" }],
      ["mac", { text: "budget", workspaceId: "mac-w", tier: "instant", own: true }],
    ]);
  });
  it("asks the sources a host named one by one, 120 ms after his last key, so each lands on its own", async () => {
    const r = rig();
    r.controller.search("budget", null, [box]);
    r.asked[0].answer({ groups: [group("thread", ["t1"])], pending: [{ source: "search.mail", kind: "mail" }, { source: "search.task", kind: "task" }], quiet: [] });
    await r.tick(0);
    expect(r.keys()).toEqual(["t1"]);
    expect(r.asked).toHaveLength(1);
    await r.tick(119);
    expect(r.asked).toHaveLength(1);
    await r.tick(1);
    expect(r.asked.slice(1).map((a) => a.params)).toEqual([
      { text: "budget", sources: ["search.mail"] },
      { text: "budget", sources: ["search.task"] },
    ]);
    // the slow one holds up no other
    r.asked[2].answer({ groups: [group("task", ["k1"])], pending: [], quiet: [] });
    await r.tick(0);
    expect(r.keys()).toEqual(["k1", "t1"]);
    expect(busy(r.controller.model)).toBe(true);
    r.asked[1].answer({ groups: [group("mail", ["m1"])], pending: [], quiet: [] });
    await r.tick(0);
    expect(r.keys()).toEqual(["m1", "k1", "t1"]);
    expect(busy(r.controller.model)).toBe(false);
  });
  it("asks them at once when the host's first answer came after the wait was over", async () => {
    const r = rig();
    r.controller.search("budget", null, [box]);
    await r.tick(300);
    r.asked[0].answer({ groups: [], pending: [{ source: "search.mail", kind: "mail" }], quiet: [] });
    await r.tick(0);
    expect(r.asked).toHaveLength(2);
  });
  it("never asks the network for words he has since changed, and drops their late answers", async () => {
    const r = rig();
    r.controller.search("bud", null, [box]);
    r.asked[0].answer({ groups: [group("thread", ["old"])], pending: [{ source: "search.mail", kind: "mail" }], quiet: [] });
    await r.tick(50);
    r.controller.search("budget", null, [box]);
    await r.tick(200);
    // the first words' mail was never asked: its wait was cancelled
    expect(r.asked.map((a) => a.params.text)).toEqual(["bud", "budget"]);
    r.asked[1].answer({ groups: [group("thread", ["new"])], pending: [], quiet: [] });
    await r.tick(0);
    expect(r.keys()).toEqual(["new"]);
  });
  it("says a host that did not answer, and a source that did not, each in one line, and keeps the rest", async () => {
    const r = rig();
    r.controller.search("budget", null, [box, mac]);
    r.asked[1].fail();
    r.asked[0].answer({ groups: [group("thread", ["t1"])], pending: [{ source: "search.mail", kind: "mail" }], quiet: [] });
    await r.tick(120);
    r.asked[2].fail();
    await r.tick(0);
    const notes = rowsOf(r.controller.model).flatMap((row) => (row.type === "note" ? [row.text] : []));
    expect(r.keys()).toEqual(["t1"]);
    expect(notes).toEqual(["MacBook did not answer.", "The box did not answer."]);
    expect(busy(r.controller.model)).toBe(false);
  });
  it("tells whoever reads it of every change, and asks nothing more once closed", async () => {
    const r = rig();
    let told = 0;
    const off = r.controller.subscribe(() => told++);
    r.controller.search("budget", null, [box]);
    expect(told).toBe(1);
    r.asked[0].answer({ groups: [], pending: [{ source: "search.mail", kind: "mail" }], quiet: [] });
    await r.tick(0);
    expect(told).toBe(2);
    r.controller.close();
    await r.tick(500);
    expect(r.asked).toHaveLength(1);
    off();
  });
  it("moves the highlight by an arrow and by the pointer", async () => {
    const r = rig();
    r.controller.search("budget", null, [box]);
    r.asked[0].answer({ groups: [group("thread", ["t1", "t2", "t3"])], pending: [], quiet: [] });
    await r.tick(0);
    r.controller.step(rowsOf(r.controller.model), 1);
    expect(r.controller.model.active).toBe("hit:t2");
    r.controller.point("hit:t3");
    expect(r.controller.model).toMatchObject({ active: "hit:t3", moved: true });
  });
});
