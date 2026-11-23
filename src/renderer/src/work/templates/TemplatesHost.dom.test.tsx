// @vitest-environment jsdom
/**
 * The pillar's ways in: open.ts asks through `workTemplatePort` and loads no
 * chunk itself, TemplatesHost fills the port while it is mounted and shows each
 * dialog on the workspace's own host, and the shelf follows the
 * `work.templates` push for its workspace or for all of them.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, cleanup, render, renderHook, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerPush } from "@shared/contract";

const host: { asked: { env: string; method: string; params: Record<string, unknown> }[]; pushes: ((push: ServerPush) => void)[] } = { asked: [], pushes: [] };
vi.mock("../../lib/connection", async (original) => ({
  ...(await original<object>()),
  registry: {
    linkOf: (env: string) => ({
      onPush: (listener: (push: ServerPush) => void) => {
        host.pushes.push(listener);
        return () => {};
      },
      request: async (method: string, params: Record<string, unknown>) => {
        host.asked.push({ env, method, params });
        return method === "work.templates.list" ? { templates: [], hidden: 0 } : {};
      },
    }),
  },
}));
vi.mock("../../lib/tcserver/workspaces", async (original) => {
  const workspaces = [{ id: "ws", environmentId: "box", name: "Dummy Esports", path: "/w/Dummy Esports" }];
  return { ...(await original<object>()), useWorkspaces: () => workspaces, workspaceStore: { getSnapshot: () => ({ workspaces }) } };
});

const { openTemplates, saveAsTemplate } = await import("./open");
const { TemplatesHost } = await import("./TemplatesHost");
const { useTemplates } = await import("./data");
const { workTemplatePort } = await import("./open");

const settle = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));

beforeEach(() => {
  host.asked.length = 0;
  host.pushes.length = 0;
});
afterEach(cleanup);

describe("the templates port", () => {
  it("answers false while Work's shell is not up", () => {
    expect(openTemplates({ workspaceId: "ws" })).toBe(false);
    expect(saveAsTemplate({ workspaceId: "ws", source: { at: "file", host: "box", path: "/w/a.docx" } })).toBe(false);
  });

  it("is filled while the host is mounted, and opens each dialog on the workspace's host", async () => {
    const { unmount } = render(<TemplatesHost />);
    expect(workTemplatePort.get()).not.toBeNull();
    act(() => void openTemplates({ workspaceId: "ws" }));
    await settle();
    expect(await screen.findByRole("heading", { name: "New from a template" })).toBeTruthy();
    expect(host.asked).toEqual([{ env: "box", method: "work.templates.list", params: { workspaceId: "ws" } }]);
    act(() => void saveAsTemplate({ workspaceId: "ws", source: { at: "file", host: "box", path: "/w/Dummy Esports/Brief.docx" } }));
    expect(await screen.findByRole("heading", { name: "Save as template" })).toBeTruthy();
    unmount();
    expect(workTemplatePort.get()).toBeNull();
  });

  it("keeps open.ts free of any chunk: it reaches the dialogs through the port alone", () => {
    const text = readFileSync(join(__dirname, "open.ts"), "utf8");
    expect(text).not.toMatch(/import\(|defineChunk|from "\.\/(?!open)/);
  });
});

describe("the shelf's data", () => {
  it("asks again on a push for its workspace or for all of them, and not for another's", async () => {
    renderHook(() => useTemplates("box", "ws"));
    await settle();
    const lists = () => host.asked.filter((a) => a.method === "work.templates.list").length;
    expect(lists()).toBe(1);
    act(() => host.pushes.forEach((p) => p({ push: "work.templates", workspaceId: "other" } as ServerPush)));
    await settle();
    expect(lists()).toBe(1);
    act(() => host.pushes.forEach((p) => p({ push: "work.templates", workspaceId: "ws" } as ServerPush)));
    await settle();
    act(() => host.pushes.forEach((p) => p({ push: "work.templates", workspaceId: null } as ServerPush)));
    await settle();
    expect(lists()).toBe(3);
  });
});
