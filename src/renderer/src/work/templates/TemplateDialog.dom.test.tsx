// @vitest-environment jsdom
/**
 * "New from a template": the title and the two groups; "Kept in" only when a
 * folder was given; a tile with no fields makes its file with the window's own
 * day, opens it in a Files tab (no thread) and closes; a tile with fields turns
 * the same dialog to them, the first focused, Return moving on and making from
 * the last, Create never greyed, read only while making, the host's refusal one
 * red line in its words; Back returns to the tiles, and a dialog opened on one
 * template has none.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dayOf, type Template } from "@shared/work/templates";

const host: { asked: { method: string; params: Record<string, unknown> }[]; answer: (method: string, params: Record<string, unknown>) => unknown } = { asked: [], answer: () => null };
vi.mock("../../lib/connection", async (original) => ({
  ...(await original<object>()),
  registry: {
    linkOf: () => ({
      onPush: () => () => {},
      request: async (method: string, params: Record<string, unknown>) => {
        host.asked.push({ method, params });
        return host.answer(method, params);
      },
    }),
  },
}));
vi.mock("../../lib/tcserver/workspaces", async (original) => {
  const workspaces = [{ id: "ws", environmentId: "box", name: "Dummy Esports", path: "/w/Dummy Esports" }];
  return { ...(await original<object>()), useWorkspaces: () => workspaces, workspaceStore: { getSnapshot: () => ({ workspaces }) } };
});
const opened = vi.fn();
vi.mock("../../lib/workSwitch", async (original) => ({ ...(await original<object>()), openWorkView: (v: unknown) => opened(v) }));

const { TemplateDialog } = await import("./TemplateDialog");

const tpl = (id: string, name: string, fields: string[] = []): Template => ({ id, name, kind: "document", form: "docx", where: id.startsWith("job:") ? "job" : id.startsWith("all:") ? "all" : "starter", fields, source: { at: "file", host: "box", path: `/w/Templates/${name}.docx` } });
const MEMO = tpl("job:Crew memo.docx", "Crew memo");
const REPORT = tpl("starter:ref/game-report", "Game report", ["Home", "Away", "Site"]);
const MADE = { source: { at: "file", host: "box", path: "/w/Dummy Esports/Game report - North.docx" }, kind: "document", title: "Game report - North", unfilled: [] };
const settle = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));
const asked = (method: string) => host.asked.filter((a) => a.method === method).map((a) => a.params);

beforeEach(() => {
  host.asked.length = 0;
  opened.mockReset();
  host.answer = (method) => (method === "work.templates.list" ? { templates: [MEMO, REPORT], hidden: 0 } : method === "work.templates.make" ? MADE : method === "work.files.open" ? { tabs: [] } : null);
});
afterEach(cleanup);

describe("New from a template", () => {
  it("shows the two groups under its title, with Cancel and no Kept in line when no folder was given", async () => {
    render(<TemplateDialog env="box" workspaceId="ws" onClose={() => {}} />);
    await settle();
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("heading", { name: "New from a template" })).toBeTruthy();
    expect(within(dialog).getByRole("region", { name: "Dummy Esports" })).toBeTruthy();
    expect(dialog.querySelector("[data-footer-note]")).toBeNull();
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeTruthy();
    expect(within(dialog).queryByRole("button", { name: "Create" })).toBeNull();
  });

  it("names the folder the file is kept in when one was given", async () => {
    render(<TemplateDialog env="box" workspaceId="ws" into={{ at: "file", host: "box", path: "/w/Dummy Esports/Invoices" }} onClose={() => {}} />);
    await settle();
    expect(screen.getByRole("dialog").querySelector("[data-footer-note]")!.textContent).toBe("Kept in Invoices");
  });

  it("makes a template with no fields on one press, in the given folder with the window's own day, opens it in Files and closes", async () => {
    const onClose = vi.fn();
    const into = { at: "file" as const, host: "box", path: "/w/Dummy Esports/Invoices" };
    render(<TemplateDialog env="box" workspaceId="ws" into={into} onClose={onClose} />);
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Crew memo" }));
    await settle();
    expect(asked("work.templates.make")).toEqual([{ workspaceId: "ws", template: "job:Crew memo.docx", into, today: dayOf(new Date()) }]);
    expect(asked("work.files.open")).toEqual([{ workspaceId: "ws", ref: MADE.source }]);
    expect(opened).toHaveBeenCalledWith({ workspaceId: "ws", view: "files" });
    expect(host.asked.some((a) => a.method.startsWith("session."))).toBe(false);
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("turns to the fields of a template that has some: its name as the title, one field each in order, the first focused, Create never greyed", async () => {
    render(<TemplateDialog env="box" workspaceId="ws" onClose={() => {}} />);
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Game report" }));
    await settle();
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("heading", { name: "Game report" })).toBeTruthy();
    expect(asked("work.templates.make")).toEqual([]);
    const fields = within(dialog).getAllByRole("textbox");
    expect(fields.map((f) => dialog.querySelector(`label[for="${f.id}"]`)!.textContent)).toEqual(["Home", "Away", "Site"]);
    expect(document.activeElement).toBe(fields[0]);
    const create = within(dialog).getByRole("button", { name: "Create" });
    expect(create.hasAttribute("disabled")).toBe(false);
    // The swap is a fade of the arriving step, and none under reduced motion.
    expect(fields[0]!.closest("[class*='starting:opacity-0']")!.className).toContain("motion-reduce:transition-none");
  });

  it("moves on with Return and makes from the last field, sending only what he typed", async () => {
    render(<TemplateDialog env="box" workspaceId="ws" onClose={() => {}} />);
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Game report" }));
    await settle();
    const [home, away, site] = screen.getAllByRole("textbox");
    fireEvent.change(home!, { target: { value: "North" } });
    fireEvent.keyDown(home!, { key: "Enter" });
    expect(document.activeElement).toBe(away);
    fireEvent.keyDown(away!, { key: "Enter" });
    expect(asked("work.templates.make")).toEqual([]);
    fireEvent.keyDown(site!, { key: "Enter" });
    await settle();
    expect(asked("work.templates.make")).toEqual([{ workspaceId: "ws", template: "starter:ref/game-report", fields: { Home: "North" }, today: dayOf(new Date()) }]);
  });

  it("holds the fields read only while making, Create spinning, and shows the host's refusal in its words as one red line", async () => {
    let refuse: (err: Error) => void = () => {};
    host.answer = (method) => (method === "work.templates.list" ? { templates: [MEMO, REPORT], hidden: 0 } : method === "work.templates.make" ? new Promise((_, no) => (refuse = no)) : null);
    render(<TemplateDialog env="box" workspaceId="ws" onClose={() => {}} />);
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Game report" }));
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await settle();
    expect(screen.getAllByRole("textbox").every((f) => f.hasAttribute("readonly"))).toBe(true);
    expect(screen.getByRole("button", { name: "Create" }).querySelector("[data-busy]")).not.toBeNull();
    await act(async () => refuse(new Error("refused: the workspace's folder is gone")));
    await settle();
    const line = screen.getByText("The workspace's folder is gone");
    expect(line.className).toContain("text-destructive");
    expect(screen.getAllByRole("textbox").some((f) => f.hasAttribute("readonly"))).toBe(false);
    expect(opened).not.toHaveBeenCalled();
  });

  it("goes back to the tiles from the fields", async () => {
    render(<TemplateDialog env="box" workspaceId="ws" onClose={() => {}} />);
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Game report" }));
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    await settle();
    expect(screen.getByRole("heading", { name: "New from a template" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Crew memo" })).toBeTruthy();
  });

  it("opened on one template starts at its fields, with no way back", async () => {
    render(<TemplateDialog env="box" workspaceId="ws" template={REPORT} onClose={() => {}} />);
    await settle();
    expect(screen.getByRole("heading", { name: "Game report" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
  });

  it("says the shelf did not load in the host's words, with Retry", async () => {
    host.answer = () => Promise.reject(new Error("refused: work is off on this host"));
    render(<TemplateDialog env="box" workspaceId="ws" onClose={() => {}} />);
    await settle();
    expect(screen.getByText("Templates did not load")).toBeTruthy();
    expect(screen.getByText("Work is off on this host")).toBeTruthy();
    host.answer = (method) => (method === "work.templates.list" ? { templates: [MEMO], hidden: 0 } : null);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await settle();
    expect(screen.getByRole("button", { name: "Crew memo" })).toBeTruthy();
  });

  it("holds Cancel too while a tile's file is made", async () => {
    let done: (v: unknown) => void = () => {};
    host.answer = (method) => (method === "work.templates.list" ? { templates: [MEMO, REPORT], hidden: 0 } : method === "work.templates.make" ? new Promise((r) => (done = r)) : {});
    render(<TemplateDialog env="box" workspaceId="ws" onClose={() => {}} />);
    await settle();
    expect(screen.getByRole("button", { name: "Cancel" }).hasAttribute("disabled")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Crew memo" }));
    await settle();
    expect(screen.getByRole("button", { name: "Cancel" }).hasAttribute("disabled")).toBe(true);
    await act(async () => done(MADE));
  });

  it("puts the focus on the first tile when the shelf arrives, so the arrows work at once", async () => {
    render(<TemplateDialog env="box" workspaceId="ws" onClose={() => {}} />);
    await settle();
    await settle();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Crew memo" }));
  });

  it("lets a long Kept in folder wrap so it can be read whole", async () => {
    render(<TemplateDialog env="box" workspaceId="ws" into={{ at: "file", host: "box", path: "/w/Dummy Esports/Season twelve game reports and crew notes" }} onClose={() => {}} />);
    await settle();
    const note = screen.getByText(/^Kept in Season twelve/);
    expect(note.className).toContain("whitespace-normal");
  });

  it("keeps the tiles' height when it turns to the fields, the footer at the bottom, so the dialog does not jump", async () => {
    const heights = vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
      return this.dataset.step === "tiles" ? 520 : 0;
    });
    try {
      render(<TemplateDialog env="box" workspaceId="ws" onClose={() => {}} />);
      await settle();
      fireEvent.click(screen.getByRole("button", { name: "Game report" }));
      await settle();
      const step = document.querySelector<HTMLElement>('[data-step="fields"]')!;
      expect(step.style.minHeight).toBe("520px");
      // The fields' body grows to fill it, so the footer stands at the bottom.
      expect(step.querySelector('[data-slot="dialog-footer"]')!.previousElementSibling!.className.split(" ")).toContain("flex-1");
    } finally {
      heights.mockRestore();
    }
  });

  it("returns the focus to the tile that opened the fields, one in All jobs past the first row", async () => {
    const VISIT = tpl("all:Visit.docx", "Visit", ["Venue"]);
    host.answer = (method) => (method === "work.templates.list" ? { templates: [MEMO, REPORT, tpl("starter:ref/a", "Another"), tpl("starter:ref/b", "Brief"), VISIT], hidden: 0 } : {});
    render(<TemplateDialog env="box" workspaceId="ws" onClose={() => {}} />);
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Visit" }));
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    await settle();
    const visit = screen.getByRole("button", { name: "Visit" });
    expect(document.activeElement).toBe(visit);
    // It holds the tab stop too, so Tab out and back lands on it.
    expect(visit.tabIndex).toBe(0);
  });

  it("opens a made file again when its open failed, and never makes a second", async () => {
    let opens = 0;
    const onClose = vi.fn();
    host.answer = (method) => {
      if (method === "work.templates.list") return { templates: [MEMO, REPORT], hidden: 0 };
      if (method === "work.templates.make") return MADE;
      if (method === "work.files.open" && opens++ === 0) return Promise.reject(new Error("refused: the Files view is busy"));
      return {};
    };
    render(<TemplateDialog env="box" workspaceId="ws" onClose={onClose} />);
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Crew memo" }));
    await settle();
    await settle();
    expect(screen.getByRole("alert").textContent).toBe("Game report - North was made but did not open. The Files view is busy");
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Crew memo" }));
    await settle();
    expect(asked("work.templates.make")).toHaveLength(1);
    expect(asked("work.files.open")).toHaveLength(2);
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("announces a refusal under the fields as it arrives, leaving the values and the focus where they were", async () => {
    host.answer = (method) => (method === "work.templates.list" ? { templates: [MEMO, REPORT], hidden: 0 } : method === "work.templates.make" ? Promise.reject(new Error("refused: the workspace's folder is gone")) : {});
    render(<TemplateDialog env="box" workspaceId="ws" onClose={() => {}} />);
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Game report" }));
    await settle();
    const [home] = screen.getAllByRole("textbox");
    // The live region is there before the refusal, so its arrival is read out.
    const region = screen.getByRole("alert");
    expect(region.textContent).toBe("");
    fireEvent.change(home!, { target: { value: "North" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    home!.focus();
    await settle();
    expect(region.textContent).toBe("The workspace's folder is gone");
    expect((home as HTMLInputElement).value).toBe("North");
    expect(document.activeElement).toBe(home);
  });

  it("sets Back's chevron on the content's edge", async () => {
    render(<TemplateDialog env="box" workspaceId="ws" onClose={() => {}} />);
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Game report" }));
    await settle();
    expect(screen.getByRole("button", { name: "Back" }).className.split(" ")).toContain("-ms-3");
  });
});
