import { describe, expect, it } from "vitest";
import { DEGRADED_GRACE_MS, degradedFor, linkWords } from "./degraded";
import { IDLE_STATUS, type EnvironmentStatus } from "./types";

const at = (transport: EnvironmentStatus["transport"], extra: Partial<EnvironmentStatus> = {}): EnvironmentStatus => ({ ...IDLE_STATUS, transport, ...extra });

describe("degraded", () => {
  it("waits out the grace for a drop that may come back, never for a refused key or a stopped host", () => {
    expect(degradedFor(at("open"), 10_000)).toBeNull();
    expect(degradedFor(at("reconnecting"), DEGRADED_GRACE_MS - 1)).toBeNull();
    expect(degradedFor(at("reconnecting"), DEGRADED_GRACE_MS)?.kind).toBe("reconnecting");
    expect(degradedFor(at("connecting"), 0)).toBeNull();
    expect(degradedFor(at("unauthorized"), 0)?.kind).toBe("unauthorized");
    expect(degradedFor(at("offline"), 0)?.kind).toBe("offline");
  });

  // The one table of a link's words: the line, every held control's tooltip and the Hosts row read it.
  it("words each state once, with the countdown only when asked and never the transport's text", () => {
    const now = 1_000_000;
    const words = (kind: EnvironmentStatus["transport"], extra: Partial<EnvironmentStatus> = {}, when?: number, online = true) =>
      linkWords("The box", { kind: kind as never, status: at(kind, extra) }, when, online);
    expect(words("reconnecting", { nextRetryAt: now + 4_400 }, now)).toBe("Reconnecting to the box in 5 s");
    expect(words("reconnecting", { nextRetryAt: now + 4_400 })).toBe("Reconnecting to the box…");
    expect(words("reconnecting", { nextRetryAt: null }, now)).toBe("Reconnecting to the box…");
    expect(words("connecting")).toBe("Connecting to the box…");
    expect(words("offline", { lastError: "connect ECONNREFUSED 10.0.0.2:8443" })).toBe("The box is offline");
    expect(words("offline", { lastError: "network down" }, undefined, false)).toBe("This computer is offline");
    expect(words("offline", { lastError: "host identity changed: expected env_a, got env_b" })).toBe("The box is not the host this computer paired with");
    expect(words("unauthorized")).toBe("The box no longer accepts this key");
    expect(linkWords("studio", { kind: "offline", status: at("offline") })).toBe("Studio is offline");
    expect(linkWords("MacBook", { kind: "connecting", status: at("connecting") })).toBe("Connecting to MacBook…");
  });
});
