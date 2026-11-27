// @vitest-environment jsdom
/** A Work workspace's research options carry no Worktree isolation switch; a code workspace's do. */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_RULES } from "@server/shared/rules";

vi.mock("../lib/tcserver/rules", () => ({ useRulesScope: () => ({ scope: { rules: DEFAULT_RULES }, catalog: null }) }));
vi.mock("../lib/tcserver/workspaces", () => ({
  useWorkspaces: () => [
    { id: "job", environmentId: "local", kind: "work" },
    { id: "repo", environmentId: "local", kind: "code" },
  ],
}));

import { ThreadTune } from "./ThreadTune";

afterEach(cleanup);

describe("ThreadTune", () => {
  it("draws no Worktree isolation for a Work workspace", () => {
    render(<ThreadTune environmentId="local" workspaceId="job" tune={{}} onChange={() => {}} />);
    expect(screen.getByRole("switch", { name: "Verify agent reports" })).toBeTruthy();
    expect(screen.queryByRole("switch", { name: "Worktree isolation" })).toBeNull();
  });

  it("names its instructions box by a label, not by its placeholder", () => {
    render(<ThreadTune environmentId="local" workspaceId="repo" tune={{}} onChange={() => {}} />);
    const box = screen.getByLabelText("Instructions");
    expect(box.tagName).toBe("TEXTAREA");
    expect(box.getAttribute("placeholder")).toBe("Optional");
    expect(box.hasAttribute("aria-label")).toBe(false);
  });

  it("keeps it for a code workspace", () => {
    render(<ThreadTune environmentId="local" workspaceId="repo" tune={{}} onChange={() => {}} />);
    expect(screen.getByRole("switch", { name: "Worktree isolation" })).toBeTruthy();
  });
});
