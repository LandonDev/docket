import { describe, expect, it } from "vitest";
import { IDLE_STATUS, type EnvironmentStatus } from "./connection/types";
import { capsText, hostErrorText, kindOf, originText, statusText } from "./hostConnection";

const at = (transport: EnvironmentStatus["transport"], extra: Partial<EnvironmentStatus> = {}): EnvironmentStatus => ({ ...IDLE_STATUS, transport, ...extra });

describe("host connection words", () => {
  it("words each state as `linkWords` does, without the host's name and with no countdown", () => {
    const now = Date.now();
    expect(statusText(at("open", { fresh: true }))).toBe("Connected");
    expect(statusText(at("open"))).toBe("Catching up");
    expect(statusText(at("connecting"))).toBe("Connecting…");
    expect(statusText(at("reconnecting", { nextRetryAt: now + 4200 }))).toBe("Reconnecting…");
    expect(statusText(at("offline"), false, true)).toBe("Offline");
    expect(statusText(at("offline"), false, false)).toBe("This computer is offline");
    expect(statusText(at("offline", { lastError: "host identity changed: x" }), false, true)).toBe("Not the host this computer paired with");
    expect(statusText(at("unauthorized"))).toBe("No longer accepts this key");
  });
  it("says a connected host is slow to answer, and leaves the other states as they were", () => {
    expect(statusText(at("open", { fresh: true }), true)).toBe("Slow to answer");
    expect(statusText(at("open"), true)).toBe("Slow to answer");
    expect(statusText(at("reconnecting"), true)).toBe("Reconnecting…");
    expect(statusText(at("offline"), true, true)).toBe("Offline");
  });
  it("names what a key may do beyond reading", () => {
    expect(capsText(["read"])).toBe("read only");
    expect(capsText(["read", "operate", "approve"])).toBe("operate, approve");
    expect(capsText(["admin", "operate", "read", "approve"])).toBe("operate, approve, admin");
  });
  it("shows the main process's detail as the one error line", () => {
    expect(hostErrorText(new Error("unauthorized: https://h refused the pairing code (expired, used, or mistyped)"))).toBe("https://h refused the pairing code (expired, used, or mistyped)");
    expect(hostErrorText(new Error("self: https://h is this machine"))).toBe("That is this machine.");
    expect(hostErrorText(new Error("contract: https://h speaks contract v2 and this app speaks v1; update the app"))).toBe("https://h speaks contract v2 and this app speaks v1; update the app");
    expect(hostErrorText(new Error("not connected"))).toBe("not connected");
  });
  it("classifies routes the way the main process does and shows hosts", () => {
    expect(kindOf("http://127.0.0.1:7677")).toBe("loopback");
    expect(kindOf("ws://192.168.1.20:7677/ws")).toBe("lan");
    expect(kindOf("https://tempcode.example.com")).toBe("tunnel");
    expect(kindOf("garbage")).toBe("tunnel");
    expect(originText("wss://tempcode.example.com/ws")).toBe("tempcode.example.com");
    expect(originText("ws://127.0.0.1:7677/ws")).toBe("127.0.0.1:7677");
  });
});
