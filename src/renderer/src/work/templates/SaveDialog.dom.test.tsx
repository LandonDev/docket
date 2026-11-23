// @vitest-environment jsdom
/**
 * "Save as template": the name filled with the file's and selected, All jobs
 * sent as `everywhere`, the fields named once (in the dialog when the caller
 * knew them, else in the toast from the host's answer), the toast "Saved to
 * Templates" with Show only once the Templates row is on, and a refusal as one
 * red line.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Template } from "@shared/work/templates";

const host: { asked: { method: string; params: Record<string, unknown> }[]; answer: (method: string) => unknown } = { asked: [], answer: () => null };
vi.mock("../../lib/connection", async (original) => ({
  ...(await original<object>()),
  registry: {
    linkOf: () => ({
      onPush: () => () => {},
      request: async (method: string, params: Record<string, unknown>) => {
        host.asked.push({ method, params });
        return host.answer(method);
      },
    }),
  },
}));
const toasts: { title: string; options: Record<string, unknown> }[] = [];
vi.mock("../../components/ui/toaster", async (original) => ({
  ...(await original<object>()),
  loadToast: async () => ({ success: (title: string, options: Record<string, unknown>) => toasts.push({ title, options }) }),
}));

const { SaveDialog } = await import("./SaveDialog");
const { TEMPLATES_ROW } = await import("../views/registry");

const SOURCE = { at: "file" as const, host: "box", path: "/w/Dummy Esports/Game report.docx" };
const saved = (fields: string[]): Template => ({ id: "job:Game report.docx", name: "Game report", kind: "document", form: "docx", where: "job", fields, source: SOURCE });
const settle = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));

beforeEach(() => {
  host.asked.length = 0;
  toasts.length = 0;
  host.answer = () => saved(["Client", "Game"]);
});
afterEach(cleanup);

describe("Save as template", () => {
  it("fills the name with the file's, selected, and offers All jobs", async () => {
    render(<SaveDialog env="box" workspaceId="ws" source={SOURCE} onClose={() => {}} />);
    await settle();
    const name = screen.getByRole("textbox") as HTMLInputElement;
    expect(name.value).toBe("Game report");
    expect(document.activeElement).toBe(name);
    expect([name.selectionStart, name.selectionEnd]).toEqual([0, "Game report".length]);
    expect((screen.getByRole("checkbox", { name: "All jobs" }) as HTMLElement).getAttribute("aria-checked")).toBe("false");
    expect(screen.getByRole("button", { name: "Save" })).toBeTruthy();
  });

  it("saves for all jobs under the name typed, then says so once with the fields the host found", async () => {
    const onClose = vi.fn();
    render(<SaveDialog env="box" workspaceId="ws" source={SOURCE} onClose={onClose} />);
    await settle();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Match report" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "All jobs" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await settle();
    expect(host.asked).toEqual([{ method: "work.templates.save", params: { workspaceId: "ws", source: SOURCE, name: "Match report", everywhere: true } }]);
    expect(toasts.map((t) => [t.title, t.options.description])).toEqual([["Saved to Templates", "Asks for Client and Game."]]);
    // Show leads to the Templates view, so it is there only with the view's row.
    expect(!!toasts[0]!.options.action).toBe(TEMPLATES_ROW);
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("names the fields in the dialog when the caller knew them, and not again in the toast", async () => {
    render(<SaveDialog env="box" workspaceId="ws" source={SOURCE} name="Game report" fields={["Client", "Game"]} onClose={() => {}} />);
    await settle();
    const line = screen.getByText("Asks for Client and Game.");
    expect(line.className).toContain("text-muted-foreground");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await settle();
    expect(toasts[0]!.options.description).toBeUndefined();
  });

  it("says nothing of fields for a file that has none", async () => {
    host.answer = () => saved([]);
    render(<SaveDialog env="box" workspaceId="ws" source={SOURCE} fields={[]} onClose={() => {}} />);
    await settle();
    expect(screen.queryByText(/^Asks for/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await settle();
    expect(toasts[0]!.options.description).toBeUndefined();
  });

  it("keeps the dialog open with the host's refusal as one red line", async () => {
    host.answer = () => Promise.reject(new Error("refused: only a document, sheet or deck can be a template"));
    const onClose = vi.fn();
    render(<SaveDialog env="box" workspaceId="ws" source={SOURCE} onClose={onClose} />);
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await settle();
    expect(screen.getByText("Only a document, sheet or deck can be a template").className).toContain("text-destructive");
    expect(toasts).toEqual([]);
    expect(onClose).not.toHaveBeenCalled();
  });
});
