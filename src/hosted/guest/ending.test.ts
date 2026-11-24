import { describe, expect, it } from "vitest";
import { afterRevoked, CLOSE_REVOKED, endingSocket } from "./ending";

/** A socket that opens nothing: the browser's events, dispatched by the test as the host's close would be. */
class Quiet extends EventTarget {
  constructor(readonly url: string) {
    super();
  }
}
const closeOf = (code: number): Event => Object.assign(new Event("close"), { code });

describe("the guest document's socket", () => {
  it("tells the page when the host closes it as revoked, and of no other close", () => {
    let told = 0;
    const Socket = endingSocket(() => void told++, Quiet as unknown as typeof WebSocket);
    const ws = new Socket("ws://h/g/ws/L1") as unknown as Quiet;
    expect(ws.url).toBe("ws://h/g/ws/L1");
    for (const code of [1000, 1006, 4401, 4503]) ws.dispatchEvent(closeOf(code));
    expect(told).toBe(0);
    ws.dispatchEvent(closeOf(CLOSE_REVOKED));
    expect(told).toBe(1);
    expect(CLOSE_REVOKED).toBe(4403);
  });
});

describe("after the host closed a page's socket as revoked", () => {
  const run = async (refresh: () => Promise<{ role: string }>): Promise<string> => {
    let said = "";
    await afterRevoked(refresh, "edit", { gone: () => (said = "gone"), reopen: () => (said = "reopen"), again: () => (said = "again") });
    return said;
  };
  it("ends the page when the link is gone, opens it again as a changed role, else reconnects", async () => {
    expect(await run(() => Promise.reject(Object.assign(new Error("gone"), { why: "gone" })))).toBe("gone");
    expect(await run(() => Promise.resolve({ role: "view" }))).toBe("reopen");
    expect(await run(() => Promise.resolve({ role: "edit" }))).toBe("again");
    // A failure in passing (the network) is not an end.
    expect(await run(() => Promise.reject(Object.assign(new Error("down"), { why: "down" })))).toBe("again");
  });
});
