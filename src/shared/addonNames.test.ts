import { describe, expect, it } from "vitest";
import { addonCallOf, addonTitle } from "./addonNames";

describe("addonTitle", () => {
  it("names a known product its own way", () => {
    expect(addonTitle("lifeos")).toBe("LifeOS");
    expect(addonTitle("github")).toBe("GitHub");
  });
  it("title-cases any other server name by its words", () => {
    expect(addonTitle("cosmic-admin")).toBe("Cosmic Admin");
    expect(addonTitle("node_repl")).toBe("Node REPL");
  });
});

describe("addonCallOf", () => {
  it("reads Claude's exposed add-on tool", () => {
    expect(addonCallOf("mcp__app__lifeos__list_tasks", {})).toEqual({ addon: "lifeos", tool: "list_tasks" });
  });
  it("reads the bridge's addon_call by its input", () => {
    const input = { tool: "lifeos__list_tasks", arguments: {} };
    expect(addonCallOf("mcp__app__addon_call", input)).toEqual({ addon: "lifeos", tool: "list_tasks" });
    expect(addonCallOf("app.addon_call", input)).toEqual({ addon: "lifeos", tool: "list_tasks" });
  });
  it("is null for the app's own tools and every other call", () => {
    expect(addonCallOf("mcp__app__update_notes", {})).toBeNull();
    expect(addonCallOf("mcp__app__addon_call", {})).toBeNull();
    expect(addonCallOf("mcp__lifeos__list_tasks", {})).toBeNull();
    expect(addonCallOf("Bash", { command: "ls" })).toBeNull();
  });
});
