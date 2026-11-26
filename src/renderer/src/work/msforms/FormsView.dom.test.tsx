// @vitest-environment jsdom
/**
 * The Forms view on a stand-in host: both kinds in one list, newest first, and a
 * Microsoft form gone since the list was read falls back to the list, read again.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FormListRow, MsFormView } from "@shared/contract-work-msforms";

const host = vi.hoisted(() => ({
  ours: [] as FormListRow[],
  ms: [] as Partial<MsFormView>[],
  reads: 0,
  opened: [] as unknown[],
  fail: false,
  bad: [] as string[],
  old: false,
  forgot: [] as unknown[],
}));
vi.mock("../../chrome/ConfirmDialog", async (original) => ({ ...(await original<typeof import("../../chrome/ConfirmDialog")>()), confirmAction: async () => true }));
vi.mock("../../lib/connection", async (original) => {
  const link = {
    request: async (method: string, params: { formId?: string } = {}) => {
      if (host.bad.includes(method)) throw new Error("The host refused the read");
      if (method === "work.forms.list") return host.ours;
      if (host.old && method === "work.msforms.list") throw new Error("Unknown method work.msforms.list");
      if (method === "work.msforms.list") return (host.reads++, { forms: host.ms, offered: false });
      if (method === "work.msforms.forget") return (host.forgot.push(params), (host.ms = host.ms.filter((f) => f.formId !== params.formId)), { ok: true });
      throw new Error(`no ${method}`);
    },
    onPush: () => () => undefined,
    onOpen: () => () => undefined,
  };
  return { ...(await original<typeof import("../../lib/connection")>()), registry: { linkOf: () => link, onLink: () => () => undefined, has: () => true, environment: () => ({ name: "The box" }) } };
});
/** A refusal the host words itself, said as it came, the computer named where it has none (`loadFailure`). */
const CAUSE = "The host refused the read";
vi.mock("../files/openFrom", () => ({
  openInFiles: async (_ws: unknown, what: unknown) => {
    host.opened.push(what);
    if (host.fail) throw new Error("That Microsoft form is not in this job.");
  },
}));
const making = vi.hoisted(() => ({ stage: null as string | null }));
vi.mock("./useFormMaking", () => ({
  useFormMaking: () => ({ offered: true, making: making.stage !== null, stage: making.stage, make: async () => undefined }),
  useLibraryPlaces: () => [],
}));
const { Head, View } = await import("./FormsView");

const FORM = "Ob0wQVN8nEGx5YdY1tY_IQaWFXVrVqJAiq2zrvrFVrNURDVET1gyWlpLNkJXOUsyWEJXNFlKMzMxVC4u";
const props = { env: "local", workspace: { id: "w1", environmentId: "local", name: "Esports" }, sector: "purdue", lifeos: {}, startThread: () => undefined } as never;

afterEach(() => {
  cleanup();
  host.reads = 0;
  host.opened = [];
  host.fail = false;
  host.bad = [];
  host.old = false;
});

describe("the Forms view", () => {
  it("lists both kinds newest first and opens a Microsoft form in Files", async () => {
    host.ours = [{ kind: "ours", id: "item1", title: "Volunteer sign-up", state: "draft", count: null, lastAnswerAt: null, updatedAt: 10 }];
    host.ms = [{ formId: FORM, tenant: "purdue0", title: "Spring intramurals", state: "collecting", count: 4, lastAnswerAt: null, updatedAt: 20 }];
    render(<View {...props} />);
    await waitFor(() => expect(screen.getAllByRole("listitem")).toHaveLength(2));
    expect(screen.getAllByRole("listitem").map((li) => li.textContent)).toEqual(["Spring intramuralsMicrosoft, collecting, 4 responses", "Volunteer sign-upDocket, draft"]);
    fireEvent.click(screen.getByRole("button", { name: /Spring intramurals/ }));
    await waitFor(() => expect(host.opened).toHaveLength(1));
    expect(host.opened[0]).toMatchObject({ ref: { at: "msform", formId: FORM, workspaceId: "w1", tenant: "purdue0" }, name: "Spring intramurals" });
  });

  it("reads the list again when a form is gone", async () => {
    host.ours = [];
    host.ms = [{ formId: FORM, tenant: "purdue0", title: "Spring intramurals", state: "closed", count: 4, lastAnswerAt: null, updatedAt: 20 }];
    host.fail = true;
    render(<View {...props} />);
    fireEvent.click(await screen.findByRole("button", { name: /Spring intramurals/ }));
    await waitFor(() => expect(host.reads).toBe(2));
  });

  it("takes a Microsoft form off the list on his Remove from List, and asks Forms nothing", async () => {
    host.ours = [];
    host.ms = [{ formId: FORM, tenant: "purdue0", title: "TempCode proof gone", state: "draft", count: 0, lastAnswerAt: null, updatedAt: 20 }];
    render(<View {...props} />);
    fireEvent.contextMenu(await screen.findByRole("button", { name: /TempCode proof gone/ }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Remove from List" }));
    await waitFor(() => expect(host.forgot).toEqual([{ workspaceId: "w1", formId: FORM }]));
    expect(await screen.findByText("No forms yet")).toBeTruthy();
    expect(host.opened).toEqual([]);
  });

  it("keeps the forms that came back and names the missing source", async () => {
    host.ours = [{ kind: "ours", id: "item1", title: "Volunteer sign-up", state: "draft", count: null, lastAnswerAt: null, updatedAt: 10 }];
    host.bad = ["work.msforms.list"];
    render(<View {...props} />);
    expect(await screen.findByText("Volunteer sign-up")).toBeTruthy();
    // Council round 1, sitting E (R1-E11): the view's state line, with its cause and a Retry that asks again.
    const line = document.querySelector('[data-view-state="failed"]') as HTMLElement;
    expect(line.textContent).toContain("Microsoft Forms did not load");
    expect(line.textContent).toContain(CAUSE);
    // Round 2: a cause the narrow line cuts reads whole in the line's tip, as Templates' does.
    expect(line.closest("[data-state-tip]")).not.toBeNull();
    expect(screen.queryByText("No forms yet")).toBeNull();
    host.bad = [];
    host.ms = [{ formId: FORM, tenant: "purdue0", title: "TempCode proof back", state: "draft", count: 0, lastAnswerAt: null, updatedAt: 20 }];
    fireEvent.click(within(line).getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("TempCode proof back")).toBeTruthy();
    expect(screen.getByText("Volunteer sign-up")).toBeTruthy();
    expect(document.querySelector('[data-view-state="failed"]')).toBeNull();
  });

  it("retries failed reads without first calling the list empty", async () => {
    host.ours = [];
    host.ms = [];
    host.bad = ["work.forms.list", "work.msforms.list"];
    render(<View {...props} />);
    expect(await screen.findByText("Forms did not load")).toBeTruthy();
    // Council round 1, sitting E (R1-E12): the cause under the title, in his words.
    expect(screen.getByText(CAUSE)).toBeTruthy();
    expect(screen.queryByText("No forms yet")).toBeNull();
    host.bad = [];
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("No forms yet")).toBeTruthy();
  });

  it("skips an absent source and reports a failure in the only source the host has", async () => {
    host.old = true;
    host.bad = ["work.forms.list"];
    render(<View {...props} />);
    expect(await screen.findByText("Forms did not load")).toBeTruthy();
    expect(screen.queryByText("Microsoft Forms did not load")).toBeNull();
  });

  /** Council round 1, sitting E (R1-E13): at rest no spinner's room sits between the glyph and the words. */
  it("draws New form at rest as every view's New: the glyph, then the words", () => {
    making.stage = null;
    render(<Head {...props} />);
    const press = screen.getByRole("button", { name: "New form" });
    expect(press.firstElementChild?.tagName.toLowerCase()).toBe("svg");
    expect(press.querySelector("span")).toBeNull();
    expect(press.textContent).toBe("New form");
  });

  it("says each stage of a make on New's own press while it runs", () => {
    making.stage = "Adding the questions…";
    render(<Head {...props} />);
    const press = screen.getByRole("button", { name: /Adding the questions…/ });
    expect(press.hasAttribute("disabled")).toBe(true);
    expect(press.querySelector("[data-slot=busy-label]")?.getAttribute("data-busy-text")).toBe("Adding the questions…");
    cleanup();
    making.stage = null;
    render(<Head {...props} />);
    expect(screen.getByRole("button", { name: "New form" }).hasAttribute("disabled")).toBe(false);
  });

  it("says when there are none", async () => {
    host.ours = [];
    host.ms = [];
    render(<View {...props} />);
    expect(await screen.findByText("No forms yet")).toBeTruthy();
  });
});
