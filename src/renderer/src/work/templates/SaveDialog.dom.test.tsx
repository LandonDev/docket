// @vitest-environment jsdom
/**
 * "Save as template": the name filled with the file's stem (a Microsoft file's
 * too) and selected, "Use in all jobs" sent as `everywhere`, the fields named
 * once in their own muted line under the check row (the caller's, else the
 * host's read of the file as the dialog opens; the toast says them only when
 * that read did not answer), a blank name kept in the form with its error, the
 * toast "Saved to Templates" with Show only once the Templates row is on, and a
 * refusal as one red line.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Template } from "@shared/work/templates";

const host: { asked: { method: string; params: Record<string, unknown> }[]; answer: (method: string) => unknown; fields: (() => unknown) | null } = { asked: [], answer: () => null, fields: null };
vi.mock("../../lib/connection", async (original) => ({
  ...(await original<object>()),
  registry: {
    linkOf: () => ({
      onPush: () => () => {},
      request: async (method: string, params: Record<string, unknown>) => {
        host.asked.push({ method, params });
        if (method === "work.templates.fields") return host.fields ? host.fields() : { fields: ["Client", "Game"] };
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
  host.fields = null;
  host.answer = () => saved(["Client", "Game"]);
});
afterEach(cleanup);

describe("Save as template", () => {
  const saves = () => host.asked.filter((a) => a.method === "work.templates.save").map((a) => a.params);

  it("fills the name with the file's stem, selected, and offers Use in all jobs", async () => {
    render(<SaveDialog env="box" workspaceId="ws" source={SOURCE} onClose={() => {}} />);
    await settle();
    const name = screen.getByRole("textbox") as HTMLInputElement;
    expect(name.value).toBe("Game report");
    expect(document.activeElement).toBe(name);
    expect([name.selectionStart, name.selectionEnd]).toEqual([0, "Game report".length]);
    expect((screen.getByRole("checkbox", { name: "Use in all jobs" }) as HTMLElement).getAttribute("aria-checked")).toBe("false");
    expect(screen.getByRole("button", { name: "Save" })).toBeTruthy();
  });

  it("fills the name from a Microsoft file's own name too", async () => {
    const office = { at: "microsoft" as const, host: "mac", app: "excel" as const, name: "Season plan.xlsx", ref: { kind: "path" as const, path: "/Users/sam/OneDrive/Season plan.xlsx" } };
    render(<SaveDialog env="box" workspaceId="ws" source={office} onClose={() => {}} />);
    await settle();
    expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe("Season plan");
  });

  it("reads the file's fields as it opens and names them in their own line under the check row, not as the name's hint", async () => {
    render(<SaveDialog env="box" workspaceId="ws" source={SOURCE} onClose={() => {}} />);
    await settle();
    expect(host.asked.filter((a) => a.method === "work.templates.fields")).toEqual([{ method: "work.templates.fields", params: { workspaceId: "ws", source: SOURCE } }]);
    const line = screen.getByText("Asks for Client and Game.");
    expect(line.className).toContain("text-muted-foreground");
    expect(line.previousElementSibling?.getAttribute("data-slot")).toBe("dialog-check-row");
    expect(screen.getByRole("textbox").getAttribute("aria-describedby")).toBeNull();
  });

  it("saves for all jobs under the name typed, then says it was saved without saying the fields again", async () => {
    const onClose = vi.fn();
    render(<SaveDialog env="box" workspaceId="ws" source={SOURCE} onClose={onClose} />);
    await settle();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Match report" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "Use in all jobs" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await settle();
    expect(saves()).toEqual([{ workspaceId: "ws", source: SOURCE, name: "Match report", everywhere: true }]);
    expect(toasts.map((t) => [t.title, t.options.description])).toEqual([["Saved to Templates", undefined]]);
    // Show leads to the Templates view, so it is there only with the view's row.
    expect(!!toasts[0]!.options.action).toBe(TEMPLATES_ROW);
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("asks nothing when the caller named the fields, and says them in the dialog alone", async () => {
    render(<SaveDialog env="box" workspaceId="ws" source={SOURCE} name="Game report" fields={["Home", "Away"]} onClose={() => {}} />);
    await settle();
    expect(host.asked.filter((a) => a.method === "work.templates.fields")).toEqual([]);
    expect(screen.getByText("Asks for Home and Away.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await settle();
    expect(toasts[0]!.options.description).toBeUndefined();
  });

  it("says nothing of fields for a file that has none", async () => {
    host.fields = () => ({ fields: [] });
    host.answer = () => saved([]);
    render(<SaveDialog env="box" workspaceId="ws" source={SOURCE} onClose={() => {}} />);
    await settle();
    expect(screen.queryByText(/^Asks for/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await settle();
    expect(toasts[0]!.options.description).toBeUndefined();
  });

  it("names the fields in the toast only when the read did not answer", async () => {
    host.fields = () => Promise.reject(new Error("refused: the file is gone"));
    render(<SaveDialog env="box" workspaceId="ws" source={SOURCE} onClose={() => {}} />);
    await settle();
    expect(screen.queryByText(/^Asks for/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await settle();
    expect(toasts[0]!.options.description).toBe("Asks for Client and Game.");
  });

  it("keeps a blank name in the form with its error, and sends nothing", async () => {
    const onClose = vi.fn();
    render(<SaveDialog env="box" workspaceId="ws" source={SOURCE} onClose={onClose} />);
    await settle();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "   " } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await settle();
    expect(saves()).toEqual([]);
    const error = screen.getByText("A template needs a name");
    expect(error.className).toContain("text-destructive");
    expect(screen.getByRole("textbox").getAttribute("aria-invalid")).toBe("true");
    expect(onClose).not.toHaveBeenCalled();
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
