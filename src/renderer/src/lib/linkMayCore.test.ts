import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CAPABILITIES, METHOD_CAPABILITY, accessCeiling, capabilityRefusal, type Capability } from "@shared/capabilities";
import { CORE_METHODS, capsAllow, capsAllowFullAccess, capsMay } from "./linkMayCore";

/**
 * The first-paint core (lib/linkMayCore.ts) is the host's rule for its few methods with none of its imports. It must
 * give, for every method in its table and every set of the seven capabilities, the answer `capabilityRefusal` gives;
 * and each row must be the host's own `METHOD_CAPABILITY` row.
 */

/** Every subset of the seven capabilities: 128 sets. */
const SETS: Capability[][] = Array.from({ length: 1 << CAPABILITIES.length }, (_, bits) => CAPABILITIES.filter((_, i) => bits & (1 << i)));

describe("linkMayCore", () => {
  it("covers 128 sets of the seven capabilities", () => {
    expect(CAPABILITIES).toHaveLength(7);
    expect(SETS).toHaveLength(128);
  });

  it("answers as the host's own rule for every method, every set of caps and both new-thread permissions", () => {
    const wrong: string[] = [];
    for (const method of CORE_METHODS) {
      const params = method === "session.create" ? [undefined, { permission: "auto" }, { permission: "edits" }] : [undefined];
      for (const caps of SETS) {
        for (const p of params) {
          const host = capabilityRefusal(caps, { method, params: p }) === null;
          if (capsAllow(caps, method, p) !== host) wrong.push(`${method} ${JSON.stringify(p ?? {})} [${caps.join(",")}]: core ${!host}, host ${host}`);
        }
      }
    }
    expect(wrong).toEqual([]);
  });

  it("asks accessCeiling's question as the host does", () => {
    for (const caps of SETS) expect(capsAllowFullAccess(caps), caps.join(",")).toBe(accessCeiling(caps) === undefined);
  });

  it("keeps each row to the host's table", () => {
    const source = readFileSync(join(import.meta.dirname, "linkMayCore.ts"), "utf8");
    const rows = [...source.matchAll(/^\s+"([a-zA-Z.]+)": "(\w+)",$/gm)].map(([, method, need]) => [method, need]);
    expect(rows.map(([method]) => method).sort()).toEqual([...CORE_METHODS].sort());
    for (const [method, need] of rows) expect(need, method).toBe(METHOD_CAPABILITY[method as keyof typeof METHOD_CAPABILITY]);
  });

  it("lets the window's own socket and a link with no hello yet do everything", () => {
    expect(capsMay(null, "session.send")).toBe(true);
    expect(capsMay({ caps: ["read"] }, "session.send")).toBe(true);
    expect(capsMay({ caps: ["read"], key: { id: "k" } }, "session.send")).toBe(false);
  });

  it("imports nothing at run time but the link's registry, its status hooks and the host's words", () => {
    const imports = [...readFileSync(join(import.meta.dirname, "linkMayCore.ts"), "utf8").matchAll(/^import (type )?.* from "([^"]+)";$/gm)];
    const runtime = imports.filter(([, type]) => !type).map(([, , from]) => from);
    expect(runtime).toEqual(["./connection/registry", "./connection/status", "./hostWords"]);
  });
});
