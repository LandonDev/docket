import { describe, expect, it } from "vitest";
import { CLOSE_REVOKED, endingSocket } from "./ending";

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
