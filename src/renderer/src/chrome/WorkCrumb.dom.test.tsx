// @vitest-environment jsdom
/**
 * A Work thread's crumb (docs/DESIGN.md "A thread's head"): the job's dot, its project or the job, a chevron, then the
 * thread's type glyph just before its title; a Work Chat, in no job, is its type glyph alone; a draft has no glyph.
 */
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const CATALOG = vi.hoisted(() => ({
  projects: [{ id: "m-lan", name: "Spring LAN", workspaceId: "w-job", environmentId: "local", lifeosProjectId: "lan" }],
  workspaces: [{ id: "w-job", name: "Purdue Esports", kind: "work", sector: "purdue", environmentId: "local" }],
}));
vi.mock("../lib/tcserver/workspaces", async (original) => ({ ...(await original<object>()), useWorkspaceCatalog: () => CATALOG }));

const { WorkCrumb } = await import("./WorkCrumb");

afterEach(cleanup);

const crumb = () => document.querySelector("[data-work-crumb]");

describe("WorkCrumb", () => {
  it("ends on the thread's type glyph, after the chevron", () => {
    render(<WorkCrumb thread={{ projectId: "m-lan", environmentId: "local" }} type="research" />);
    const kids = [...crumb()!.children];
    expect(kids.at(-1)!.getAttribute("data-type-glyph")).toBe("research");
    expect(kids.at(-2)!.tagName.toLowerCase()).toBe("svg");
    expect(crumb()!.textContent).toBe("Spring LAN");
  });

  it("draws a chat's glyph too: the head is the one place a chat says its type", () => {
    render(<WorkCrumb thread={{ workspaceId: "w-job", environmentId: "local" }} type={null} />);
    expect(crumb()!.querySelector("[data-type-glyph]")!.getAttribute("data-type-glyph")).toBe("chat");
  });

  it("is a Work Chat's type glyph alone, with no job to name", () => {
    render(<WorkCrumb thread={{ environmentId: "local" }} type="chat" />);
    expect(crumb()!.textContent).toBe("");
    expect(crumb()!.children).toHaveLength(1);
    expect(crumb()!.querySelector("[data-type-glyph]")).toBeTruthy();
  });

  it("draws no glyph for a draft, and nothing at all for a draft of no job", () => {
    render(<WorkCrumb thread={{ projectId: "m-lan", environmentId: "local" }} last />);
    expect(crumb()!.querySelector("[data-type-glyph]")).toBeNull();
    cleanup();
    render(<WorkCrumb thread={{ environmentId: "local" }} last />);
    expect(crumb()).toBeNull();
  });
});
