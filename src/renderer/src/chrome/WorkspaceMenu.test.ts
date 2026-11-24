import { describe, expect, it } from "vitest";
import { workspaceMenuRows } from "./WorkspaceMenu";

const ids = (rows: ReturnType<typeof workspaceMenuRows>) => rows.flatMap((r) => (r.kind === "item" ? [r.id] : []));
const dormant = () => ({ count: 0, groups: [] });

describe("workspaceMenuRows", () => {
  it("a Work workspace (no New project handler) draws no New project row, not even a disabled one", () => {
    expect(ids(workspaceMenuRows({ dormant, canNewProject: false }))).not.toContain("new-project");
  });

  it("a code workspace keeps New project", () => {
    expect(ids(workspaceMenuRows({ dormant, canNewProject: true, onNewProject: () => {} }))[0]).toBe("new-project");
  });
});
