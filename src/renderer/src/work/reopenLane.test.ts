import { afterEach, describe, expect, it } from "vitest";
import { onWorkReopen, resetReopenLanes } from "./reopenLane";

/**
 * A reconnect with six Work workspaces: the shown view's ask goes first and alone, every other Work ask waits for its
 * answer and then goes one at a time, and each goes once.
 */

function fakeLink(env = "box") {
  const opens = new Set<() => void>();
  return {
    environmentId: env,
    onOpen: (l: () => void) => (opens.add(l), () => void opens.delete(l)),
    open: () => [...opens].forEach((l) => l()),
  };
}

/** A host whose answers wait until the test lets each go; counts what is in flight, and the most at once. */
function slowHost() {
  const answers = new Map<string, () => void>();
  const asked: string[] = [];
  let flying = 0;
  let most = 0;
  const ask = (name: string) => () =>
    new Promise<void>((resolve) => {
      asked.push(name);
      flying++;
      most = Math.max(most, flying);
      answers.set(name, () => {
        flying--;
        resolve();
      });
    });
  return { ask, asked, answer: (name: string) => answers.get(name)!(), flying: () => flying, most: () => most };
}

const turn = () => new Promise((r) => setTimeout(r, 0));

afterEach(resetReopenLanes);

describe("a Work window's asks when its link opens again", () => {
  it("with six workspaces: one ask in flight before the shown view's answer, then the rest one at a time, each once", async () => {
    const link = fakeLink();
    const host = slowHost();
    // Each workspace's stores (its tabs, its places, its LifeOS status), the digest and the review: only workspace 3 is on screen.
    for (let w = 1; w <= 6; w++) {
      onWorkReopen(link, host.ask(`tabs ${w}`), () => w === 3);
      onWorkReopen(link, host.ask(`lifeos ${w}`));
    }
    onWorkReopen(link, host.ask("digest"));
    onWorkReopen(link, host.ask("review"));
    link.open();
    await turn();
    expect(host.asked).toEqual(["tabs 3"]);
    expect(host.flying()).toBe(1);
    host.answer("tabs 3");
    for (let i = 0; i < 13; i++) {
      await turn();
      expect(host.flying()).toBe(1);
      host.answer(host.asked.at(-1)!);
    }
    await turn();
    expect(host.asked).toHaveLength(14);
    expect(new Set(host.asked).size).toBe(14);
    expect(host.most()).toBe(1);
  });

  it("the next open asks each again, once", async () => {
    const link = fakeLink();
    let n = 0;
    onWorkReopen(link, () => void n++, () => true);
    onWorkReopen(link, () => void n++);
    link.open();
    await turn();
    await turn();
    link.open();
    await turn();
    await turn();
    expect(n).toBe(4);
  });

  it("a host's lane never holds another's", async () => {
    const box = fakeLink("box");
    const mac = fakeLink("mac");
    const host = slowHost();
    onWorkReopen(box, host.ask("box shown"), () => true);
    onWorkReopen(mac, host.ask("mac digest"));
    box.open();
    mac.open();
    await turn();
    expect(host.asked.sort()).toEqual(["box shown", "mac digest"]);
  });
});
