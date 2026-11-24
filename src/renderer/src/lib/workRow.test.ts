import { describe, expect, it } from "vitest";
import { isWorkSession, isWorkThread, isWorkWorkspace } from "./workRow";

describe("workRow", () => {
  const workspaces = [
    { id: "job", kind: "work" },
    { id: "repo", kind: "code" },
    { id: "old" },
  ];

  it("reads Work from the row alone", () => {
    expect(isWorkThread({ scope: "work" })).toBe(true);
    expect(isWorkThread({ scope: "code" })).toBe(false);
    expect(isWorkThread({})).toBe(false);
    expect(isWorkThread(null)).toBe(false);
    expect(isWorkWorkspace({ kind: "work" })).toBe(true);
    expect(isWorkWorkspace({ kind: "code" })).toBe(false);
    expect(isWorkWorkspace(undefined)).toBe(false);
  });

  it("a draft in a Work workspace is Work before the host stamps it; a code workspace's is not", () => {
    expect(isWorkSession({ workspaceId: "job" }, workspaces)).toBe(true);
    expect(isWorkSession({ scope: "work", workspaceId: null }, workspaces)).toBe(true);
    expect(isWorkSession({ workspaceId: "repo" }, workspaces)).toBe(false);
    expect(isWorkSession({ workspaceId: "old" }, workspaces)).toBe(false);
    expect(isWorkSession({ workspaceId: "gone" }, workspaces)).toBe(false);
    expect(isWorkSession({}, workspaces)).toBe(false);
  });
});
