// @vitest-environment jsdom
/**
 * A Work Chats row (ThreadRowView over a Work root, chrome/RowMarks.tsx): its provider in the lead where a code row
 * has its type, a type other than chat after the title, the state still at the row's end. A code row keeps its type
 * in the lead and draws no provider. The row reads the provider and the scope from the thread's summary (`threadRow`).
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { SessionMeta } from "../lib/tcserver/types";
import { threadRow } from "../lib/workspaceSessions";
import { ThreadRowView } from "./WorkspaceSessions";

const meta = (extra: Partial<SessionMeta> = {}): SessionMeta =>
  ({ environmentId: "local", id: "t1", parentId: null, projectId: null, workspaceId: null, threadType: "chat", title: "Plan the week", cwd: "/w", status: "idle", archived: false, pinned: false, busySince: null, createdAt: 1, updatedAt: 100, provider: "codex", ...extra }) as SessionMeta;

afterEach(cleanup);

const lead = () => document.querySelector("[data-thread-row] > span[aria-hidden]")!;

describe("a Work root's row", () => {
  it("carries its scope and provider from the summary; a code root carries neither", () => {
    expect(threadRow(meta({ scope: "work" }), {})).toMatchObject({ scope: "work", provider: "codex" });
    const code = threadRow(meta(), {});
    expect(code.scope).toBeUndefined();
    expect(code.provider).toBeUndefined();
  });

  it("leads with its provider and says no type for a chat", () => {
    render(<ThreadRowView row={threadRow(meta({ scope: "work" }), {})} />);
    expect(lead().querySelector("[data-provider]")!.getAttribute("data-provider")).toBe("codex");
    expect(document.querySelector("[data-type-glyph]")).toBeNull();
    expect(screen.getByRole("button", { name: "Plan the week, Codex" })).toBeTruthy();
  });

  it("trails a research thread's glyph after its title, and keeps a working state at the row's end", () => {
    render(<ThreadRowView row={threadRow(meta({ scope: "work", threadType: "research", provider: "muse", status: "running", busySince: 1 }), {})} />);
    expect(lead().querySelector("[data-provider]")!.getAttribute("data-provider")).toBe("muse");
    const glyphs = document.querySelectorAll("[data-type-glyph]");
    expect(glyphs).toHaveLength(1);
    expect(glyphs[0]!.getAttribute("data-type-glyph")).toBe("research");
    expect(lead().querySelector('[data-slot="status-mark"]')).toBeNull();
    expect(document.querySelector('[data-slot="status-mark"]')).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Plan the week, Research, Muse Code, / })).toBeTruthy();
  });
});

describe("a code root's row", () => {
  it("leads with its type glyph and draws no provider", () => {
    render(<ThreadRowView row={threadRow(meta({ threadType: "research" }), {})} />);
    expect(lead().querySelector("[data-type-glyph]")!.getAttribute("data-type-glyph")).toBe("research");
    expect(document.querySelectorAll("[data-type-glyph]")).toHaveLength(1);
    expect(document.querySelector("[data-provider]")).toBeNull();
    expect(screen.getByRole("button", { name: "Plan the week" })).toBeTruthy();
  });
});
