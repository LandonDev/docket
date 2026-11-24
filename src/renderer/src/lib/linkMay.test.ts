import { describe, expect, it } from "vitest";
import { capsMay } from "./linkMay";

const key = { id: "k1", name: "a key" };
const owner = { caps: ["read", "operate", "approve", "admin"] as const, key };
/** What a setup link gives a computer (docs/agents/pc-setup.md). */
const laptop = { caps: ["operate", "approve", "device"] as const, key };
const reader = { caps: ["read"] as const, key };

describe("what a link may do, by the host's own rule", () => {
  it("an owner's key may change a host's settings; a given computer's and a read key may not", () => {
    expect(capsMay(owner, "work.set", { enabled: true })).toBe(true);
    expect(capsMay(laptop, "work.set", { enabled: true })).toBe(false);
    expect(capsMay(reader, "work.set", { enabled: true })).toBe(false);
  });

  it("a given computer may operate and approve, and is never handed the host's LifeOS session", () => {
    expect(capsMay(laptop, "session.send")).toBe(true);
    expect(capsMay(laptop, "work.lifeos.jwt")).toBe(false);
    expect(capsMay(owner, "work.lifeos.jwt")).toBe(true);
    expect(capsMay(reader, "session.send")).toBe(false);
  });

  it("the window's own socket holds no key and may do everything, local-only calls too", () => {
    expect(capsMay({ caps: ["read", "operate", "approve", "admin", "give"] }, "work.set")).toBe(true);
    expect(capsMay({ caps: ["read", "operate", "approve", "admin", "give"] }, "work.lifeos.setToken")).toBe(true);
    // The same call from any key is refused: it is local-only.
    expect(capsMay(owner, "work.lifeos.setToken")).toBe(false);
  });

  it("hides nothing on a guess: no hello yet answers true", () => {
    expect(capsMay(null, "work.set")).toBe(true);
  });
});
