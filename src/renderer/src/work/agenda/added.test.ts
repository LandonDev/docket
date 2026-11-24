import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ADD_WAIT_MS, tellAdded, type OpWatcher } from "./added";

/** LifeOS's row, as a watch reads it: set it, and every listener hears. */
function lifeos(): OpWatcher & { set(row: unknown): void; watching(): number } {
  let row: unknown;
  const listeners = new Set<() => void>();
  return {
    watchQuery: () => ({ onUpdate: (cb) => (listeners.add(cb), () => void listeners.delete(cb)), localQueryResult: () => row }),
    set(next) {
      row = next;
      for (const cb of [...listeners]) cb();
    },
    watching: () => listeners.size,
  };
}
const toaster = () => {
  const said: { how: string; words: string; description?: string }[] = [];
  const say = (how: string) => (words: string, o?: { description?: string }) => void said.push({ how, words, ...(o?.description ? { description: o.description } : {}) });
  return { said, api: { loading: say("loading"), success: say("success"), error: say("error"), message: say("message") } as never };
};

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("the New event toast says only what is true", () => {
  it("reads Adding while LifeOS has it queued, and Added only once LifeOS has done it", () => {
    const client = lifeos();
    const toast = toaster();
    tellAdded(client, toast.api, { id: "op1", title: "Walk the ballroom", invites: false });
    client.set({ status: "queued" });
    client.set({ status: "sending" });
    expect(toast.said).toEqual([{ how: "loading", words: "Adding Walk the ballroom" }]);
    client.set({ status: "done" });
    expect(toast.said.at(-1)).toEqual({ how: "success", words: "Added Walk the ballroom" });
    expect(client.watching()).toBe(0);
  });

  it("never says Invites sent before they went, and says a later refusal with its reason", () => {
    const client = lifeos();
    const toast = toaster();
    tellAdded(client, toast.api, { id: "op2", title: "Budget review", invites: true });
    client.set({ status: "queued" });
    expect(toast.said.map((t) => t.words)).toEqual(["Sending invites: Budget review"]);
    client.set({ status: "failed", error: "Google refused the write: the calendar is read only." });
    expect(toast.said.at(-1)).toEqual({ how: "error", words: "Budget review was not added", description: "Google refused the write: the calendar is read only." });
    expect(client.watching()).toBe(0);
  });

  it("says where it stands when LifeOS gives no answer in time, and stops watching", () => {
    const client = lifeos();
    const toast = toaster();
    tellAdded(client, toast.api, { id: "op3", title: "Scrim", invites: false });
    client.set({ status: "queued" });
    vi.advanceTimersByTime(ADD_WAIT_MS);
    expect(toast.said.at(-1)).toEqual({ how: "message", words: "Scrim is queued in LifeOS", description: "It shows on Agenda once Google has it." });
    expect(client.watching()).toBe(0);
    client.set({ status: "done" });
    expect(toast.said).toHaveLength(2);
  });
});
