// @vitest-environment jsdom
/**
 * Rename: a blank name keeps the dialog open with the Name's own error and
 * sends nothing; the host's refusal is that error too, and the dialog stays;
 * a new name goes to the host and closes it.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Template } from "@shared/work/templates";

const host: { asked: { method: string; params: Record<string, unknown> }[]; answer: () => unknown } = { asked: [], answer: () => ({}) };
vi.mock("../../lib/connection", async (original) => ({
  ...(await original<object>()),
  registry: {
    linkOf: () => ({
      onPush: () => () => {},
      request: async (method: string, params: Record<string, unknown>) => {
        host.asked.push({ method, params });
        return host.answer();
      },
    }),
  },
}));

const { RenameDialog } = await import("./RenameDialog");

const MEMO: Template = { id: "job:Crew memo.docx", name: "Crew memo", kind: "document", form: "docx", where: "job", fields: [], source: { at: "file", host: "box", path: "/w/Templates/Crew memo.docx" } };
const settle = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));

beforeEach(() => {
  host.asked.length = 0;
  host.answer = () => MEMO;
});
afterEach(cleanup);

describe("Rename template", () => {
  it("keeps a blank name in the dialog with the Name's error, and sends nothing", async () => {
    const onClose = vi.fn();
    render(<RenameDialog env="box" workspaceId="ws" template={MEMO} onClose={onClose} />);
    await settle();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "  " } });
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    await settle();
    expect(host.asked).toEqual([]);
    expect(screen.getByText("A template needs a name").className).toContain("text-destructive");
    expect(screen.getByRole("textbox").getAttribute("aria-invalid")).toBe("true");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("keeps the dialog open on a name the host refuses, its words as the Name's error", async () => {
    host.answer = () => Promise.reject(new Error("refused: a template of that name is on the shelf"));
    const onClose = vi.fn();
    render(<RenameDialog env="box" workspaceId="ws" template={MEMO} onClose={onClose} />);
    await settle();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Weekly" } });
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    await settle();
    expect(screen.getByText("A template of that name is on the shelf").className).toContain("text-destructive");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("sends a new name and closes", async () => {
    const onClose = vi.fn();
    render(<RenameDialog env="box" workspaceId="ws" template={MEMO} onClose={onClose} />);
    await settle();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Crew note" } });
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    await settle();
    expect(host.asked).toEqual([{ method: "work.templates.rename", params: { workspaceId: "ws", template: MEMO.id, name: "Crew note" } }]);
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });
});
