// @vitest-environment jsdom
/**
 * The Forms view on a stand-in host: both kinds in one list, newest first, and a
 * Microsoft form gone since the list was read falls back to the list, read again.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FormListRow, MsFormView } from "@shared/contract-work-msforms";

const host = vi.hoisted(() => ({
  ours: [] as FormListRow[],
  ms: [] as Partial<MsFormView>[],
  reads: 0,
  opened: [] as unknown[],
  fail: false,
  forgot: [] as unknown[],
}));
vi.mock("../../chrome/ConfirmDialog", async (original) => ({ ...(await original<typeof import("../../chrome/ConfirmDialog")>()), confirmAction: async () => true }));
vi.mock("../../lib/connection", async (original) => {
  const link = {
    request: async (method: string, params: { formId?: string } = {}) => {
      if (method === "work.forms.list") return host.ours;
      if (method === "work.msforms.list") return (host.reads++, { forms: host.ms, offered: false });
      if (method === "work.msforms.forget") return (host.forgot.push(params), (host.ms = host.ms.filter((f) => f.formId !== params.formId)), { ok: true });
      throw new Error(`no ${method}`);
    },
    onPush: () => () => undefined,
    onOpen: () => () => undefined,
  };
  return { ...(await original<typeof import("../../lib/connection")>()), registry: { linkOf: () => link, onLink: () => () => undefined, has: () => true } };
});
vi.mock("../files/openFrom", () => ({
  openInFiles: async (_ws: unknown, what: unknown) => {
    host.opened.push(what);
    if (host.fail) throw new Error("That Microsoft form is not in this job.");
  },
}));
const { View } = await import("./FormsView");

const FORM = "Ob0wQVN8nEGx5YdY1tY_IQaWFXVrVqJAiq2zrvrFVrNURDVET1gyWlpLNkJXOUsyWEJXNFlKMzMxVC4u";
const props = { env: "local", workspace: { id: "w1", environmentId: "local", name: "Esports" }, sector: "purdue", lifeos: {}, startThread: () => undefined } as never;

afterEach(() => {
  cleanup();
  host.reads = 0;
  host.opened = [];
  host.fail = false;
});

describe("the Forms view", () => {
  it("lists both kinds newest first and opens a Microsoft form in Files", async () => {
    host.ours = [{ kind: "ours", id: "item1", title: "Volunteer sign-up", state: "draft", count: null, lastAnswerAt: null, updatedAt: 10 }];
    host.ms = [{ formId: FORM, tenant: "purdue0", title: "Spring intramurals", state: "collecting", count: 4, lastAnswerAt: null, updatedAt: 20 }];
    render(<View {...props} />);
    await waitFor(() => expect(screen.getAllByRole("listitem")).toHaveLength(2));
    expect(screen.getAllByRole("listitem").map((li) => li.textContent)).toEqual(["Spring intramuralsMicrosoft · Collecting · 4", "Volunteer sign-upTempCode · Draft"]);
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

  it("says when there are none", async () => {
    host.ours = [];
    host.ms = [];
    render(<View {...props} />);
    expect(await screen.findByText("No forms yet")).toBeTruthy();
  });
});
