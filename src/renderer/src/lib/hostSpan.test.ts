import { describe, expect, it } from "vitest";
import { ONE_HOST, rowHosts, spansHosts } from "./hostSpan";
import type { ThreadRow } from "./workspaceSessions";

const row = (environmentId: string | undefined, more: Partial<ThreadRow> = {}) => ({ id: "t", environmentId, ...more }) as ThreadRow;

describe("spansHosts", () => {
  it("is false for no hosts, one host, or one host and threads that name none", () => {
    expect(spansHosts([])).toBe(false);
    expect(spansHosts(["env_a", "env_a"])).toBe(false);
    expect(spansHosts([undefined, "env_a", null, "env_a"])).toBe(false);
  });

  it("is true from a second host on", () => {
    expect(spansHosts(["env_a", "env_b"])).toBe(true);
    expect(spansHosts([null, "env_a", "env_a", "env_b"])).toBe(true);
  });

  it("reads a row's subagents and its batch as well as the row", () => {
    expect(spansHosts(rowHosts([row("env_a", { children: [row("env_a")] })]))).toBe(false);
    expect(spansHosts(rowHosts([row("env_a", { children: [row("env_b")] })]))).toBe(true);
    expect(spansHosts(rowHosts([row("env_a", { batch: [row("env_a", { children: [row("env_b")] })] })]))).toBe(true);
  });

  it("hides the glyphs by a class, so no row takes a prop", () => {
    expect(ONE_HOST).toBe("[&_[data-host-glyph]]:hidden");
  });
});
