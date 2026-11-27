// @vitest-environment jsdom
/**
 * The guests pillar in the renderer: the Share sheet against a
 * fake host (the box answering for another host), the held request's view,
 * the audit list, and what a guest may write into a document as the owner's
 * own editor shows it: a `javascript:` link and a hostile paste.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const NOW = Date.UTC(2026, 10, 23, 17);
import { DocumentEditor, EditorAdaptersProvider, EditorKitProvider, type AnyEditor } from "work-kit/editor";
import type { GuestLinkRow } from "@shared/contract-work-guests";
import type { HeldItem } from "@shared/work";

const NAMES: Record<string, string> = { box: "The box", win: "Windows PC" };
const calls = vi.hoisted(() => ({ list: [] as { env: string; method: string; params: Record<string, unknown> }[], links: [] as unknown[], failOnce: false, down: new Set<string>(), downWords: {} as Record<string, string>, revokeGate: null as Promise<void> | null, revokeRefusal: null as string | null, listGate: null as Promise<void> | null, itemGate: null as Promise<void> | null, pages: {} as Record<string, string>, homes: {} as Record<string, string>, addressDown: 0, opened: [] as string[], addressGate: null as Promise<void> | null }));
vi.mock("../../lib/connection", async (original) => {
  const linkOf = (env: string) => ({
    environmentId: env,
    connected: true,
    onPush: () => () => undefined,
    request: async (method: string, params: Record<string, unknown> = {}) => {
      calls.list.push({ env, method, params });
      if (method === "work.guests.list" && calls.listGate) await calls.listGate;
      if (method === "work.guests.forItem" && calls.itemGate) await calls.itemGate;
      if (calls.down.has(env)) throw new Error(calls.downWords[env] ?? "The host did not answer");
      // The Mac does not serve LifeOS's documents: it names the box, as the host does.
      if (env === "mac") throw new Error("served elsewhere: box");
      if (calls.failOnce && method === "work.guests.forItem") {
        calls.failOnce = false;
        throw new Error("LifeOS did not answer");
      }
      if (method === "work.office.live.address" && calls.addressGate) await calls.addressGate;
      if (method === "work.office.live.address" && calls.addressDown > 0) {
        calls.addressDown -= 1;
        throw new Error("The host did not answer");
      }
      if (method === "work.office.live.address") {
        const path = (params.ref as { path: string }).path;
        return { address: calls.pages[path] ?? null, app: null, ...(calls.homes[path] ? { home: calls.homes[path] } : {}) };
      }
      if (method === "work.guests.forItem" || method === "work.guests.list") return calls.links;
      if (method === "work.guests.create")
        return { link: { ...LINK, name: params.name, role: params.role, expiresAt: params.expiresAt }, url: "https://tempcode.landonhale.com/g/abc#k=secret" };
      if (method === "work.guests.revoke") {
        if (calls.revokeGate) await calls.revokeGate;
        if (calls.revokeRefusal) throw new Error(calls.revokeRefusal);
        return { ok: true };
      }
      if (method === "work.guests.setRole") return { ok: true };
      if (method === "work.guests.rekey") return { url: "https://tempcode.landonhale.com/g/new#k=secret" };
      throw new Error(`unexpected ${method}`);
    },
  });
  return { ...(await original<typeof import("../../lib/connection")>()), registry: { linkOf, onLink: () => () => undefined, environment: (id: string) => (NAMES[id] ? { id, name: NAMES[id] } : undefined) } };
});

vi.mock("../../lib/native", async (original) => ({ ...(await original<object>()), openUrl: async (url: string) => void calls.opened.push(url) }));
const confirm = vi.hoisted(() => ({ answer: true, asked: [] as { title: string; body?: string; action: string }[] }));
vi.mock("../../chrome/ConfirmDialog", async (original) => ({
  ...(await original<object>()),
  confirmAction: async (request: { title: string; body?: string; action: string }) => (confirm.asked.push(request), confirm.answer),
}));
const toasts = vi.hoisted(() => [] as string[]);
vi.mock("../../components/ui/toaster", async (original) => ({
  ...(await original<object>()),
  loadToast: async () => Object.assign((m: string) => void toasts.push(m), { message: (m: string) => void toasts.push(m), error: (m: string) => void toasts.push(`error: ${m}`) }),
}));
const clip = vi.hoisted(() => ({ fail: false }));
vi.mock("../../lib/clipboard", () => ({
  copyText: async () => {
    if (clip.fail) throw new Error("denied");
  },
}));

const LINK: GuestLinkRow = {
  id: "abc",
  name: "Sam Ortiz",
  source: { at: "lifeos", table: "docs", id: "kd1" },
  title: "Run of show",
  role: "edit",
  createdAt: NOW,
  expiresAt: NOW + 5 * 86_400_000,
  revokedAt: null,
  by: "owner",
  lastOpenedAt: null,
  open: 1,
};

beforeEach(() => void vi.setSystemTime(NOW));
afterEach(() => {
  vi.useRealTimers();
  cleanup();
  calls.list.length = 0;
  calls.links = [];
  calls.down.clear();
  calls.downWords = {};
  calls.revokeGate = null;
  calls.addressGate = null;
  calls.revokeRefusal = null;
  calls.itemGate = null;
  calls.pages = {};
  calls.homes = {};
  calls.addressDown = 0;
  calls.opened.length = 0;
  confirm.answer = true;
  confirm.asked.length = 0;
});

describe("Share", () => {
  it("opens one sheet: the item's links from the host that serves it, and a new link shown once", async () => {
    const { ShareButton } = await import("./Share");
    calls.links = [LINK];
    render(<ShareButton env="mac" source={{ at: "lifeos", table: "docs", id: "kd1" }} kind="document" title="Run of show" />);
    fireEvent.click(screen.getByRole("button", { name: "Share" }));
    await screen.findByText("Sam Ortiz");
    expect(screen.getByRole("dialog", { name: "Share" })).toBeTruthy();
    // Who, what they can do, made, last opened and until when, in one muted comma line: never a run of dots.
    expect(screen.getByText(/^Edit, made \w{3} \d+, in it now, until \w{3} \d+$/)).toBeTruthy();
    // A list's avatar: 24px, as Settings' list draws it.
    expect(document.querySelector("[data-slot=avatar]")!.getAttribute("data-size")).toBe("24");
    // Asked of the Mac, answered by the box.
    expect(calls.list.map((c) => `${c.env}:${c.method}`)).toEqual(["mac:work.guests.forItem", "box:work.guests.forItem"]);
    expect(screen.getByRole("button", { name: "Create link" }).hasAttribute("disabled")).toBe(true);
    fireEvent.change(screen.getByRole("textbox", { name: "For" }), { target: { value: "Dana Lee" } });
    fireEvent.click(screen.getByRole("button", { name: "Comment" }));
    fireEvent.click(screen.getByRole("button", { name: "Create link" }));
    await screen.findByText("https://tempcode.landonhale.com/g/abc#k=secret");
    const made = calls.list.find((c) => c.method === "work.guests.create")!;
    expect(made).toMatchObject({ env: "mac", params: { source: { at: "lifeos", table: "docs", id: "kd1" }, title: "Run of show", name: "Dana Lee", role: "comment" } });
    // Thirty days unless he picks.
    expect(Math.round(((made.params.expiresAt as number) - NOW) / 86_400_000)).toBe(30);
    expect(screen.getByText(/shown only now/)).toBeTruthy();
    // The list is read again with the new link; New link brings the form back.
    await waitFor(() => expect(calls.list.filter((c) => c.method === "work.guests.forItem").length).toBeGreaterThan(2));
    fireEvent.click(screen.getByRole("button", { name: "New link" }));
    expect(await screen.findByRole("textbox", { name: "For" })).toBeTruthy();
  });

  /** Polish 2 council round 1 (R1-C22): in a 400px sheet a row's facts were cut, its end date with them. */
  it("lets a link's facts wrap, so the date it ends is never cut away", async () => {
    const { ShareButton } = await import("./Share");
    calls.links = [LINK];
    render(<ShareButton env="box" source={{ at: "lifeos", table: "docs", id: "kd1" }} kind="document" title="Run of show" />);
    fireEvent.click(screen.getByRole("button", { name: "Share" }));
    await screen.findByText("Sam Ortiz");
    const facts = document.querySelector<HTMLElement>("[data-share-link-facts]")!;
    expect(facts.textContent).toMatch(/until \w{3} \d+$/);
    expect(facts.className).not.toContain("truncate");
  });

  it("revokes a link and changes what it can do from the row's menu", async () => {
    const { ShareButton } = await import("./Share");
    calls.links = [LINK];
    render(<ShareButton env="box" source={{ at: "lifeos", table: "docs", id: "kd1" }} kind="document" title="Run of show" />);
    fireEvent.click(screen.getByRole("button", { name: "Share" }));
    await screen.findByText("Sam Ortiz");
    fireEvent.click(screen.getByRole("button", { name: "Sam Ortiz's link" }));
    fireEvent.click(await screen.findByRole("menuitemradio", { name: "Can view" }));
    await waitFor(() => expect(calls.list.find((c) => c.method === "work.guests.setRole")?.params).toEqual({ linkId: "abc", role: "view" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Sam Ortiz's link" }).hasAttribute("disabled")).toBe(false));
    // A radio row leaves the menu open, as a menu of choices does.
    if (!screen.queryByRole("menuitem", { name: "Revoke…" })) fireEvent.click(screen.getByRole("button", { name: "Sam Ortiz's link" }));
    // Revoke asks first, and a No revokes nothing: there is no Undo after (decision 21).
    confirm.answer = false;
    fireEvent.click(await screen.findByRole("menuitem", { name: "Revoke…" }));
    await waitFor(() => expect(confirm.asked.at(-1)).toMatchObject({ title: "Revoke the link?", body: "Sam Ortiz's address stops opening for good.", action: "Revoke" }));
    expect(calls.list.some((c) => c.method === "work.guests.revoke")).toBe(false);
    confirm.answer = true;
    fireEvent.click(screen.getByRole("button", { name: "Sam Ortiz's link" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Revoke…" }));
    await waitFor(() => expect(calls.list.find((c) => c.method === "work.guests.revoke")?.params).toEqual({ linkId: "abc" }));
  });

  it("shares a TempCode document kept as a file to view, comment or edit, as a LifeOS document: its comments are asked of the computer that has it", async () => {
    const { ShareButton } = await import("./Share");
    render(<ShareButton env="box" source={{ at: "file", host: "box", path: "/w/Plan.tcdoc" }} kind="document" title="Plan" />);
    fireEvent.click(screen.getByRole("button", { name: "Share" }));
    await screen.findByRole("textbox", { name: "For" });
    for (const can of ["View", "Comment", "Edit"]) expect(screen.getByRole("button", { name: can })).toBeTruthy();
    expect(calls.list[0]).toMatchObject({ method: "work.guests.forItem", params: { source: { at: "file", host: "box", path: "/w/Plan.tcdoc" } } });
  });

  it("offers a sheet view or edit only; a Word file and a mail's attachment say what to do instead or draw nothing", async () => {
    const { ShareButton } = await import("./Share");
    const { container, unmount } = render(<ShareButton env="box" source={{ at: "mail", threadId: "t", messageId: "m", partId: "p", name: "a.docx" }} kind="document" title="a" />);
    expect(container.innerHTML).toBe("");
    unmount();
    const word = render(<ShareButton env="box" source={{ at: "file", host: "box", path: "/x/Letter.docx" }} kind="document" title="Letter" />);
    fireEvent.click(screen.getByRole("button", { name: "Share" }));
    expect(await screen.findByText("Guest links open Docket documents. Share this file from where it lives.")).toBeTruthy();
    expect(screen.queryByRole("textbox", { name: "For" })).toBeNull();
    expect(calls.list).toEqual([]);
    word.unmount();
    render(<ShareButton env="box" source={{ at: "lifeos", table: "sheets", id: "ks1" }} kind="sheet" title="Budget" />);
    fireEvent.click(screen.getByRole("button", { name: "Share" }));
    await screen.findByRole("textbox", { name: "For" });
    expect(screen.queryByRole("button", { name: "Comment" })).toBeNull();
    expect(screen.getByRole("button", { name: "Edit" })).toBeTruthy();
  });

  it("is its bones until the host answers for the item: never a form it then refuses", async () => {
    const { ShareButton } = await import("./Share");
    let answer!: () => void;
    calls.itemGate = new Promise<void>((done) => (answer = done));
    calls.down.add("box");
    calls.downWords = { box: "This file is in a place others open. Share it from there." };
    render(<ShareButton env="box" source={{ at: "file", host: "box", path: "/w/Plan.tcdoc" }} kind="document" title="Plan" />);
    fireEvent.click(screen.getByRole("button", { name: "Share" }));
    // The bones are the form itself at rest, unseen and inert: no field he can type in.
    await waitFor(() => expect(document.querySelector("[skullet-loading] [data-share-bones]")).toBeTruthy());
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.getByRole("button", { name: "Create link" }).hasAttribute("disabled")).toBe(true);
    await act(async () => answer());
    expect(await screen.findByText("This file is in a place others open. Share it from there.")).toBeTruthy();
    expect(screen.queryByRole("textbox")).toBeNull();
    await waitFor(() => expect(document.querySelector("[data-share-bones]")).toBeNull());
  });

  it("reads Share in Teams on a library's file whose page the host knows, and opens that page; no guest link is asked", async () => {
    const { ShareButton } = await import("./Share");
    const page = "https://purdue0.sharepoint.com/sites/Esports/Shared%20Documents/General/Plan.docx?web=1";
    calls.pages = { "/w/Plan.tcdoc": page };
    render(<ShareButton env="box" source={{ at: "file", host: "box", path: "/w/Plan.tcdoc" }} kind="document" title="Plan" workspaceId="w1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Share in Teams" }));
    expect(calls.opened).toEqual([page]);
    expect(calls.list.map((c) => c.method)).toEqual(["work.office.live.address"]);
    expect(calls.list[0]!.params).toEqual({ workspaceId: "w1", ref: { at: "file", host: "box", path: "/w/Plan.tcdoc" } });
    cleanup();
    // His own OneDrive's page reads OneDrive; a file with no page keeps the Share sheet.
    calls.pages = { "/w/Mine.xlsx": "https://purdue0-my.sharepoint.com/personal/l/Documents/Mine.xlsx?web=1" };
    render(<ShareButton env="box" source={{ at: "file", host: "box", path: "/w/Mine.xlsx" }} kind="sheet" title="Mine" workspaceId="w1" />);
    expect(await screen.findByRole("button", { name: "Share in OneDrive" })).toBeTruthy();
    cleanup();
    render(<ShareButton env="box" source={{ at: "file", host: "box", path: "/w/Notes.tcdoc" }} kind="document" title="Notes" workspaceId="w1" />);
    expect(await screen.findByRole("button", { name: "Share" })).toBeTruthy();
  });

  it("draws Share at once while the host is asked for the file's page, then reads Share in Teams", async () => {
    const { ShareButton } = await import("./Share");
    let answer!: () => void;
    calls.addressGate = new Promise((r) => (answer = r));
    calls.pages = { "/w/Plan.tcdoc": "https://purdue0.sharepoint.com/sites/Esports/Shared%20Documents/General/Plan.docx?web=1" };
    render(<ShareButton env="box" source={{ at: "file", host: "box", path: "/w/Plan.tcdoc" }} kind="document" title="Plan" workspaceId="w1" />);
    expect(screen.getByRole("button", { name: "Share" })).toBeTruthy();
    await act(async () => answer());
    expect(await screen.findByRole("button", { name: "Share in Teams" })).toBeTruthy();
    calls.addressGate = null;
  });

  it("greys Share in Teams on a library's file whose page the host knows none of, saying where to share it; no sheet that only says no", async () => {
    const { ShareButton } = await import("./Share");
    calls.homes = { "/cloud/General/Plan.docx": "Teams" };
    render(<ShareButton env="box" source={{ at: "file", host: "box", path: "/cloud/General/Plan.docx" }} kind="document" title="Plan" workspaceId="w1" />);
    const greyed = await screen.findByRole("button", { name: "Share in Teams" });
    expect(greyed.hasAttribute("disabled")).toBe(true);
    expect(document.querySelector("[data-share-refused]")?.getAttribute("aria-description")).toBe("Share it from Teams.");
    calls.homes = {};
  });

  it("says where to share a library's file whose page the host knows none of, on File → Share… and on a held press", async () => {
    // Council r5 (Opus 3): the menu's Share… did nothing once the button was greyed, and a held press answered home said nothing.
    const { ShareButton } = await import("./Share");
    const { openShare } = await import("./sharePort");
    let answer!: () => void;
    calls.addressGate = new Promise((r) => (answer = r));
    calls.homes = { "/cloud/General/Plan.docx": "Teams" };
    toasts.length = 0;
    render(<ShareButton env="box" source={{ at: "file", host: "box", path: "/cloud/General/Plan.docx" }} kind="document" title="Plan" itemId="item9" workspaceId="w1" />);
    fireEvent.click(screen.getByRole("button", { name: "Share" }));
    await act(async () => answer());
    await waitFor(() => expect(toasts).toEqual(["Share it from Teams."]));
    expect(screen.queryByRole("dialog")).toBeNull();
    act(() => openShare("item9"));
    await waitFor(() => expect(toasts).toEqual(["Share it from Teams.", "Share it from Teams."]));
    expect(calls.opened).toEqual([]);
    calls.addressGate = null;
    calls.homes = {};
  });

  it("holds a press made while the page is asked for, and acts on the answer: the page opens, never the sheet", async () => {
    const { ShareButton } = await import("./Share");
    let answer!: () => void;
    calls.addressGate = new Promise((r) => (answer = r));
    const page = "https://purdue0.sharepoint.com/sites/Esports/Shared%20Documents/General/Plan.docx?web=1";
    calls.pages = { "/w/Plan.tcdoc": page };
    render(<ShareButton env="box" source={{ at: "file", host: "box", path: "/w/Plan.tcdoc" }} kind="document" title="Plan" workspaceId="w1" />);
    fireEvent.click(screen.getByRole("button", { name: "Share" }));
    await act(async () => answer());
    await waitFor(() => expect(calls.opened).toEqual([page]));
    expect(screen.queryByRole("dialog")).toBeNull();
    calls.addressGate = null;
  });

  it("shows a held press as the button busy until the answer comes", async () => {
    // Council r4 (Opus 4): the button showed nothing while the press waited.
    const { ShareButton } = await import("./Share");
    let answer!: () => void;
    calls.addressGate = new Promise((r) => (answer = r));
    const page = "https://purdue0.sharepoint.com/sites/Esports/Shared%20Documents/General/Plan.docx?web=1";
    calls.pages = { "/w/Plan.tcdoc": page };
    render(<ShareButton env="box" source={{ at: "file", host: "box", path: "/w/Plan.tcdoc" }} kind="document" title="Plan" workspaceId="w1" />);
    const share = screen.getByRole("button", { name: "Share" });
    expect(share.querySelector('[data-slot="spinner"]')).toBeNull();
    fireEvent.click(share);
    expect(share.getAttribute("aria-busy")).toBe("true");
    expect(share.querySelector('[data-slot="spinner"]')).toBeTruthy();
    await act(async () => answer());
    await waitFor(() => expect(calls.opened).toEqual([page]));
    calls.addressGate = null;
  });

  it("holds File → Share… and More made while the page is asked for as the button's own press: the page opens", async () => {
    // Council r4 (Sol 5): the menu's press opened the sheet path and never waited for the answer.
    const { ShareButton } = await import("./Share");
    const { openShare } = await import("./sharePort");
    let answer!: () => void;
    calls.addressGate = new Promise((r) => (answer = r));
    const page = "https://purdue0.sharepoint.com/sites/Esports/Shared%20Documents/General/Plan.docx?web=1";
    calls.pages = { "/w/Plan.tcdoc": page };
    render(<ShareButton env="box" source={{ at: "file", host: "box", path: "/w/Plan.tcdoc" }} kind="document" title="Plan" itemId="item7" workspaceId="w1" />);
    act(() => openShare("item7"));
    expect(screen.getByRole("button", { name: "Share" }).getAttribute("aria-busy")).toBe("true");
    await act(async () => answer());
    await waitFor(() => expect(calls.opened).toEqual([page]));
    expect(screen.queryByRole("dialog")).toBeNull();
    calls.addressGate = null;
  });

  it("asks again on a press after a lost answer, so one drop never leaves Share on the sheet", async () => {
    const { ShareButton } = await import("./Share");
    const page = "https://purdue0.sharepoint.com/sites/Esports/Shared%20Documents/General/Plan.docx?web=1";
    calls.pages = { "/w/Plan.tcdoc": page };
    calls.addressDown = 1;
    render(<ShareButton env="box" source={{ at: "file", host: "box", path: "/w/Plan.tcdoc" }} kind="document" title="Plan" workspaceId="w1" />);
    await waitFor(() => expect(calls.list.filter((c) => c.method === "work.office.live.address")).toHaveLength(1));
    fireEvent.click(screen.getByRole("button", { name: "Share" }));
    await waitFor(() => expect(calls.opened).toEqual([page]));
    expect(calls.list.filter((c) => c.method === "work.office.live.address")).toHaveLength(2);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("opens the sheet when the press's own ask is lost too, so a press never comes to nothing", async () => {
    const { ShareButton } = await import("./Share");
    calls.pages = {};
    calls.addressDown = 2;
    render(<ShareButton env="box" source={{ at: "file", host: "box", path: "/w/Plan.tcdoc" }} kind="document" title="Plan" workspaceId="w1" />);
    await waitFor(() => expect(calls.list.filter((c) => c.method === "work.office.live.address")).toHaveLength(1));
    fireEvent.click(screen.getByRole("button", { name: "Share" }));
    expect(await screen.findByRole("dialog")).toBeTruthy();
    expect(calls.list.filter((c) => c.method === "work.office.live.address")).toHaveLength(2);
  });

  it("opens the sheet for a press made while the first ask is out, when that ask is lost", async () => {
    const { ShareButton } = await import("./Share");
    calls.pages = {};
    let release = (): void => {};
    calls.addressGate = new Promise((r) => (release = r));
    calls.addressDown = 1;
    render(<ShareButton env="box" source={{ at: "file", host: "box", path: "/w/Plan.tcdoc" }} kind="document" title="Plan" workspaceId="w1" />);
    await waitFor(() => expect(calls.list.filter((c) => c.method === "work.office.live.address")).toHaveLength(1));
    fireEvent.click(screen.getByRole("button", { name: "Share" }));
    calls.addressGate = null;
    release();
    expect(await screen.findByRole("dialog")).toBeTruthy();
  });

  it("keeps only a real answer for a file's page: a lost one is asked again, never kept as none", async () => {
    const { filePageOf } = await import("./api");
    const src = { at: "file" as const, host: "box", path: "/w/Plan.docx" };
    expect(await filePageOf("box", "w1", src)).toBeNull();
    calls.down.add("box");
    expect(await filePageOf("box", "w1", src)).toBeUndefined();
  });

  it("forgets a new link's address once that link is revoked, so it cannot be copied after", async () => {
    const { ShareButton } = await import("./Share");
    calls.links = [];
    render(<ShareButton env="box" source={{ at: "lifeos", table: "docs", id: "kd1" }} kind="document" title="Run of show" />);
    fireEvent.click(screen.getByRole("button", { name: "Share" }));
    fireEvent.change(await screen.findByRole("textbox", { name: "For" }), { target: { value: "Sam Ortiz" } });
    calls.links = [LINK];
    fireEvent.click(screen.getByRole("button", { name: "Create link" }));
    await screen.findByText("https://tempcode.landonhale.com/g/abc#k=secret");
    fireEvent.click(await screen.findByRole("button", { name: "Sam Ortiz's link" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Revoke…" }));
    await waitFor(() => expect(screen.queryByText("https://tempcode.landonhale.com/g/abc#k=secret")).toBeNull());
    expect(await screen.findByRole("textbox", { name: "For" })).toBeTruthy();
  });

  it("calls a document kept for a Teams file the Teams file opened here, never a copy", async () => {
    const { SHARE_REFUSALS } = await import("@shared/work/guestRoles");
    expect(SHARE_REFUSALS.teamsCopy).not.toMatch(/copy/i);
    expect(SHARE_REFUSALS.teamsCopy).toContain("Share it from Teams");
  });

  it("says a host's refusal of a file as the sheet's one line, not as a failure", async () => {
    const { ShareButton } = await import("./Share");
    calls.down.add("box");
    calls.downWords = { box: "Guests reach files on the box only. Keep this file in a workspace on the box to share it." };
    render(<ShareButton env="box" source={{ at: "file", host: "box", path: "/w/Plan.tcdoc" }} kind="document" title="Plan" />);
    fireEvent.click(screen.getByRole("button", { name: "Share" }));
    expect(await screen.findByText("Guests reach files on the box only. Keep this file in a workspace on the box to share it.")).toBeTruthy();
    expect(screen.queryByRole("textbox", { name: "For" })).toBeNull();
    expect(screen.getByRole("button", { name: "Done" })).toBeTruthy();
  });

  it("says once, beside Create link, that a Purdue workspace's file is university data", async () => {
    const { ShareButton } = await import("./Share");
    const { PURDUE_LINE } = await import("./ShareSheet");
    render(<ShareButton env="box" source={{ at: "file", host: "box", path: "/w/Plan.tcdoc" }} kind="document" title="Plan" purdue />);
    fireEvent.click(screen.getByRole("button", { name: "Share" }));
    await screen.findByRole("textbox", { name: "For" });
    expect(screen.getByText(PURDUE_LINE).closest("[data-slot=dialog-footer]")).toBeTruthy();
  });

  it("opens from File → Share… or More through the item's own button", async () => {
    const { ShareButton } = await import("./Share");
    const { openShare } = await import("./sharePort");
    render(<ShareButton env="box" source={{ at: "lifeos", table: "docs", id: "kd1" }} kind="document" title="Run of show" itemId="item1" />);
    expect(screen.queryByRole("dialog")).toBeNull();
    openShare("other");
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByRole("dialog")).toBeNull();
    act(() => openShare("item1"));
    expect(await screen.findByRole("dialog", { name: "Share" })).toBeTruthy();
  });

  it("says a list that did not load with Retry, which asks again", async () => {
    const { ShareButton } = await import("./Share");
    calls.links = [LINK];
    calls.failOnce = true;
    render(<ShareButton env="box" source={{ at: "lifeos", table: "docs", id: "kd1" }} kind="document" title="Run of show" />);
    fireEvent.click(screen.getByRole("button", { name: "Share" }));
    await screen.findByText("LifeOS did not answer");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByText("Sam Ortiz");
    expect(screen.queryByText("LifeOS did not answer")).toBeNull();
  });

  it("says a raw failure of the sheet's read in his words, never the method", async () => {
    const { ShareButton } = await import("./Share");
    calls.down.add("box");
    calls.downWords = { box: "work.guests.forItem: no answer from the link" };
    render(<ShareButton env="box" source={{ at: "lifeos", table: "docs", id: "kd1" }} kind="document" title="Run of show" />);
    fireEvent.click(screen.getByRole("button", { name: "Share" }));
    expect(await screen.findByText("The box could not list the guest links.")).toBeTruthy();
    expect(document.body.textContent).not.toContain("work.guests");
  });

  it("keeps Retry's row, its focus and the error while it asks, busy, and takes no second press", async () => {
    const { ShareButton } = await import("./Share");
    calls.links = [LINK];
    calls.failOnce = true;
    render(<ShareButton env="box" source={{ at: "lifeos", table: "docs", id: "kd1" }} kind="document" title="Run of show" />);
    fireEvent.click(screen.getByRole("button", { name: "Share" }));
    await screen.findByText("LifeOS did not answer");
    let open: () => void = () => {};
    calls.itemGate = new Promise((r) => (open = r));
    const reads = () => calls.list.filter((c) => c.method === "work.guests.forItem").length;
    const before = reads();
    const retry = screen.getByRole("button", { name: "Retry" });
    retry.focus();
    fireEvent.click(retry);
    expect(retry.isConnected).toBe(true);
    expect(retry.hasAttribute("disabled")).toBe(true);
    expect(retry.querySelector("[data-busy]")).not.toBeNull();
    expect(document.activeElement).toBe(retry);
    expect(screen.getByText("LifeOS did not answer")).toBeTruthy();
    fireEvent.click(retry);
    expect(reads()).toBe(before + 1);
    calls.itemGate = null;
    await act(async () => open());
    await screen.findByText("Sam Ortiz");
    expect(screen.queryByText("LifeOS did not answer")).toBeNull();
  });
});

describe("a link's facts", () => {
  it("are one comma sentence everywhere, never a run of dots: what they may do where there is a choice, what it is to in a list of every link, made, opened and until; an ended link says when it ended", async () => {
    const { linkFacts } = await import("./api");
    const opened = { ...LINK, open: 0, lastOpenedAt: NOW - 3_600_000 };
    expect(linkFacts(opened)).toMatch(/^Edit, made \w{3} \d+, opened \w{3} \d+ \d+:\d{2}\s?[AP]M, until \w{3} \d+$/);
    expect(linkFacts({ ...LINK, open: 0 }, { item: true })).toMatch(/^Edit, Run of show, made \w{3} \d+, not opened yet, until \w{3} \d+$/);
    expect(linkFacts({ ...LINK, expiresAt: NOW - 1000 })).toMatch(/^Edit, made \w{3} \d+, ended \w{3} \d+$/);
    expect(linkFacts({ ...LINK, revokedAt: NOW - 1000 }, { item: true })).toMatch(/^Edit, Run of show, made \w{3} \d+, revoked \w{3} \d+$/);
    for (const line of [linkFacts(opened), linkFacts(LINK, { item: true })]) expect(line).not.toMatch(/[·|•]/);
  });
});

describe("a project's Share", () => {
  const PROJECT_LINK = { ...LINK, id: "plink", name: "Dana Lee", role: "view" as const, source: { at: "lifeos" as const, table: "projects" as const, id: "kp1" }, title: "Spring LAN", open: 0 };

  it("on the project's bar opens the sheet: its links, and a new one that can only view, asking who and until when", async () => {
    const { ProjectShare } = await import("./Share");
    calls.links = [PROJECT_LINK];
    render(<ProjectShare env="box" project={{ id: "kp1", name: "Spring LAN" }} />);
    const share = screen.getByRole("button", { name: "Share" });
    // One of the bar's quiet 28px verbs.
    expect(share.className.split(/\s+/)).toContain("h-7");
    fireEvent.click(share);
    await screen.findByText("Dana Lee");
    // Every guest of a project views: the row says nothing of what they can do.
    expect(screen.getByText(/^made .*, not opened yet, until /)).toBeTruthy();
    expect(calls.list[0]).toMatchObject({ method: "work.guests.forItem", params: { source: { at: "lifeos", table: "projects", id: "kp1" } } });
    fireEvent.change(screen.getByRole("textbox", { name: "For" }), { target: { value: "Marcus Reed" } });
    // A project's guest views: there is nothing to pick, so no Can row is drawn.
    expect(screen.queryByText("Can")).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Create link" }));
    await screen.findByText(/shown only now/);
    expect(calls.list.find((c) => c.method === "work.guests.create")?.params).toMatchObject({ source: { at: "lifeos", table: "projects", id: "kp1" }, title: "Spring LAN", name: "Marcus Reed", role: "view" });
  });

  it("is named as a project in the held request and in the list of every link", async () => {
    const { View } = await import("./ShareActView");
    const item = { kind: "share.guestLink", payload: { source: PROJECT_LINK.source, title: "Spring LAN", name: "Dana Lee", role: "view", expiresAt: Date.UTC(2026, 11, 18, 12) } } as unknown as HeldItem;
    const held = render(<View item={item} env="box" />);
    for (const words of ["Spring LAN", "Dana Lee", "View"]) expect(screen.getByText(words)).toBeTruthy();
    held.unmount();
    const { GuestLinksSection } = await import("./GuestLinksSection");
    calls.links = [PROJECT_LINK];
    render(<GuestLinksSection hosts={["box"]} />);
    // The same facts as the sheet's row, with what the link is to: a project's guest views, so no role is said.
    expect(await screen.findByText(/^Spring LAN project, made \w{3} \d+, not opened yet, until \w{3} \d+$/)).toBeTruthy();
  });
});

describe("the held request and the audit list", () => {
  it("shows the link an agent asked for, exactly", async () => {
    const { View } = await import("./ShareActView");
    const item = { kind: "share.guestLink", payload: { source: { at: "lifeos", table: "sheets", id: "ks1" }, title: "Nationals travel budget", name: "Dana Lee", role: "edit", expiresAt: Date.UTC(2026, 11, 18, 12) } } as unknown as HeldItem;
    render(<View item={item} env="box" />);
    for (const words of ["Nationals travel budget", "Dana Lee", "Edit"]) expect(screen.getByText(words)).toBeTruthy();
    expect(screen.getByText(/Dec 18/)).toBeTruthy();
  });

  it("names a file's held request by the file and its folder's name, never a disk path", async () => {
    const { View } = await import("./ShareActView");
    const item = { kind: "share.guestLink", payload: { source: { at: "file", host: "box", path: "/srv/work/purdue/Trips/Field trip plan.tcdoc" }, title: "Field trip plan", name: "Dana Lee", role: "comment", expiresAt: Date.UTC(2026, 11, 18, 12) } } as unknown as HeldItem;
    render(<View item={item} env="box" />);
    expect(screen.getByText("Field trip plan")).toBeTruthy();
    expect(screen.getByText("in Trips")).toBeTruthy();
    expect(screen.queryByText("In")).toBeNull();
    expect(document.body.textContent).not.toContain("/srv/work");
  });

  it("keeps a row with its menu busy until the host confirms a revoke, and a refusal visible with the row still there", async () => {
    const { ShareButton } = await import("./Share");
    calls.links = [LINK];
    let open: () => void = () => {};
    calls.revokeGate = new Promise((r) => (open = r));
    render(<ShareButton env="box" source={{ at: "lifeos", table: "docs", id: "kd1" }} kind="document" title="Run of show" />);
    fireEvent.click(screen.getByRole("button", { name: "Share" }));
    await screen.findByText("Sam Ortiz");
    fireEvent.click(screen.getByRole("button", { name: "Sam Ortiz's link" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Revoke…" }));
    // Pending: the row stays and its menu is busy.
    await waitFor(() => expect(screen.getByRole("button", { name: "Sam Ortiz's link" }).hasAttribute("disabled")).toBe(true));
    expect(screen.getByText("Sam Ortiz")).toBeTruthy();
    calls.revokeRefusal = "The link was already opened elsewhere";
    await act(async () => open());
    await waitFor(() => expect(screen.getByText(/The link was already opened elsewhere/)).toBeTruthy());
    expect(screen.getByText("Sam Ortiz")).toBeTruthy();
  });

  it("lists a file's link with the file's name and the folder it is in, by the folder's name alone, and says who is in it now", async () => {
    const { GuestLinksSection } = await import("./GuestLinksSection");
    calls.links = [{ ...LINK, id: "file1", name: "Dana Lee", title: "Field trip plan", open: 2, source: { at: "file", table: "docs", id: "f".repeat(40), host: "box", path: "/srv/work/purdue/Trips/Field trip plan.tcdoc" } }];
    render(<GuestLinksSection hosts={["box"]} />);
    await screen.findByText("Dana Lee");
    expect(screen.getByText(/^Edit, Field trip plan in Trips, made \w{3} \d+, in it now, until \w{3} \d+$/)).toBeTruthy();
    // No path is shown in a row.
    expect(document.body.textContent).not.toContain("/srv/work");
  });

  it("lists every link, live first, a revoked one muted with no Revoke", async () => {
    const { GuestLinksSection } = await import("./GuestLinksSection");
    calls.links = [{ ...LINK, id: "old", name: "Maya Chen", revokedAt: NOW - 1000, open: 0 }, LINK];
    render(<GuestLinksSection hosts={["box"]} />);
    await screen.findByText("Sam Ortiz");
    const names = screen.getAllByText(/Sam Ortiz|Maya Chen/).map((n) => n.textContent);
    expect(names).toEqual(["Sam Ortiz", "Maya Chen"]);
    expect(screen.getByText(/^Edit, Run of show, made \w{3} \d+, in it now, until \w{3} \d+$/)).toBeTruthy();
    expect(screen.getByText(/^Edit, Run of show, made \w{3} \d+, revoked \w{3} \d+$/)).toBeTruthy();
    // Replace address… and Revoke… sit in the live row's menu, there at rest; the revoked row says so in a word.
    expect(screen.getAllByRole("button", { name: /'s link$/ })).toHaveLength(1);
    // The revoked link says when, once, in its line.
    expect(document.querySelector('[data-guest-link="old"]')!.textContent!.match(/revoked/gi)).toHaveLength(1);
    await pickLink("Revoke…");
    expect(confirm.asked.at(-1)).toMatchObject({ action: "Revoke" });
  });

  it("says a host's raw failure in his words, naming the computer", async () => {
    const { GuestLinksSection } = await import("./GuestLinksSection");
    calls.links = [LINK];
    calls.down.add("win");
    calls.downWords = { win: "work.guests.list: socket hung" };
    render(<GuestLinksSection hosts={["box", "win"]} />);
    expect(await screen.findByText("Windows PC could not list its guest links.")).toBeTruthy();
    expect(document.body.textContent).not.toContain("work.guests");
  });

  it("keeps the links one host gave when another does not answer, with Retry, and lists a link read through two hosts once", async () => {
    const { GuestLinksSection } = await import("./GuestLinksSection");
    calls.links = [LINK];
    calls.down.add("win");
    render(<GuestLinksSection hosts={["box", "mac", "win"]} />);
    await screen.findByText("Sam Ortiz");
    expect(screen.getAllByText("Sam Ortiz")).toHaveLength(1);
    expect(screen.getByText("Windows PC did not answer. Try again once it is connected.")).toBeTruthy();
    calls.down.clear();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Retry" })));
    await waitFor(() => expect(screen.queryByText("Windows PC did not answer. Try again once it is connected.")).toBeNull());
    expect(screen.getByText("Sam Ortiz")).toBeTruthy();
  });

  it("spins a failed host's Retry while it asks, and takes no second press meanwhile", async () => {
    const { GuestLinksSection } = await import("./GuestLinksSection");
    calls.links = [LINK];
    calls.down.add("win");
    render(<GuestLinksSection hosts={["box", "win"]} />);
    await screen.findByText("Windows PC did not answer. Try again once it is connected.");
    calls.down.clear();
    let open: () => void = () => {};
    calls.listGate = new Promise((r) => (open = r));
    const retry = screen.getByRole("button", { name: "Retry" });
    const asked = calls.list.length;
    fireEvent.click(retry);
    expect(retry.hasAttribute("disabled")).toBe(true);
    expect(retry.querySelector("[data-busy]")).not.toBeNull();
    fireEvent.click(retry);
    expect(calls.list.filter((c) => c.method === "work.guests.list")).toHaveLength(calls.list.slice(0, asked).filter((c) => c.method === "work.guests.list").length + 2);
    calls.listGate = null;
    await act(async () => open());
    await waitFor(() => expect(screen.queryByText("The host did not answer")).toBeNull());
  });

  it("Replace address… asks first, saying the old address stops opening, and rekeys only on Replace", async () => {
    const { GuestLinksSection } = await import("./GuestLinksSection");
    calls.links = [LINK];
    render(<GuestLinksSection hosts={["box"]} />);
    await screen.findByText("Sam Ortiz");
    expect((document.querySelector("[data-slot=avatar]") as HTMLElement).getAttribute("data-size")).toBe("24");
    confirm.answer = false;
    await pickLink("Replace address…");
    expect(confirm.asked.at(-1)!.body).toBe("Sam Ortiz's current address stops opening. The new one shows here for you to copy.");
    expect(calls.list.some((c) => c.method === "work.guests.rekey")).toBe(false);
    confirm.answer = true;
    await pickLink("Replace address…");
    expect(calls.list.filter((c) => c.method === "work.guests.rekey").map((c) => c.params)).toEqual([{ linkId: "abc" }]);
  });

  it("shows the new address once in the link-made dialog, with Copy, and says so when Copy fails", async () => {
    const { GuestLinksSection } = await import("./GuestLinksSection");
    calls.links = [LINK];
    render(<GuestLinksSection hosts={["box"]} />);
    await screen.findByText("Sam Ortiz");
    await pickLink("Replace address…");
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("https://tempcode.landonhale.com/g/new#k=secret");
    expect(dialog.textContent).toContain("shown only now");
    // Copy there fails: it says so, and the address stays to select.
    clip.fail = true;
    await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: "Copy" })));
    expect(dialog.textContent).toContain("It didn't copy");
    clip.fail = false;
    // Done closes it, and the address is not shown again.
    await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: "Done" })));
    await waitFor(() => expect(document.body.textContent).not.toContain("g/new#k=secret"));
  });

  it("Revoke… asks first in the list of every link, and revokes only on Revoke", async () => {
    const { GuestLinksSection } = await import("./GuestLinksSection");
    calls.links = [LINK];
    render(<GuestLinksSection hosts={["box"]} />);
    await screen.findByText("Sam Ortiz");
    confirm.answer = false;
    await pickLink("Revoke…");
    expect(confirm.asked.at(-1)).toMatchObject({ title: "Revoke the link?", body: "Sam Ortiz's address stops opening for good.", action: "Revoke" });
    expect(calls.list.some((c) => c.method === "work.guests.revoke")).toBe(false);
    confirm.answer = true;
    await pickLink("Revoke…");
    await waitFor(() => expect(calls.list.filter((c) => c.method === "work.guests.revoke").map((c) => c.params)).toEqual([{ linkId: "abc" }]));
  });

  it("keeps a line for each host that did not answer, with one Retry for the section", async () => {
    const { GuestLinksSection } = await import("./GuestLinksSection");
    calls.links = [LINK];
    calls.down.add("win");
    calls.down.add("phone");
    calls.downWords = { win: "The Windows PC did not answer", phone: "The phone did not answer" };
    render(<GuestLinksSection hosts={["box", "win", "phone"]} />);
    await screen.findByText("Sam Ortiz");
    await screen.findByText("The Windows PC did not answer");
    expect(screen.getByText("The phone did not answer")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Retry" })).toHaveLength(1);
    // That one Retry reads every host again.
    calls.down.clear();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Retry" })));
    await waitFor(() => expect(screen.queryByText("The phone did not answer")).toBeNull());
    expect(screen.queryByText("The Windows PC did not answer")).toBeNull();
  });

  it("says an empty list in a plain line", async () => {
    const { GuestLinksSection } = await import("./GuestLinksSection");
    render(<GuestLinksSection hosts={["box"]} />);
    expect(await screen.findByText("No guest links")).toBeTruthy();
  });

  it("draws no row when no computer gave its links: the failure says why", async () => {
    const { GuestLinksRow } = await import("./GuestLinksSection");
    calls.down.add("box");
    render(<GuestLinksRow hosts={["box"]} />);
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(document.querySelector('[data-setting="files.guests"]')).toBeNull();
  });

  it("is one open row on Files saying how many links are live and when the next ends, opening the list in a sheet with a find field past eight", async () => {
    const { GuestLinksRow, guestsWords } = await import("./GuestLinksSection");
    expect(guestsWords([], NOW)).toBe("None");
    expect(guestsWords([{ ...LINK, revokedAt: NOW - 1 }], NOW)).toBe("None");
    expect(guestsWords([LINK, { ...LINK, id: "b", expiresAt: LINK.expiresAt + 86_400_000 }], NOW)).toMatch(/^2 links\. The next ends \w{3} \d+$/);
    calls.links = Array.from({ length: 9 }, (_, i) => ({ ...LINK, id: `l${i}`, name: i === 3 ? "Dana Lee" : `Guest ${i}` }));
    render(<GuestLinksRow hosts={["box"]} />);
    expect(await screen.findByText(/^9 links\. The next ends/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Shared with guests" }));
    const sheet = await screen.findByRole("dialog");
    fireEvent.change(within(sheet).getByRole("searchbox", { name: "Find a link" }), { target: { value: "dana" } });
    expect(within(sheet).getByText("Dana Lee")).toBeTruthy();
    expect(within(sheet).queryByText("Guest 1")).toBeNull();
  });
});

/** Opens Sam Ortiz's row menu in the list of every link and picks one of its acts. */
async function pickLink(item: string) {
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Sam Ortiz's link" })));
  const row = await screen.findByRole("menuitem", { name: item });
  await act(async () => fireEvent.click(row));
}

// jsdom has neither; the editor's paste builds one of each, as a browser's paste event carries them.
class TestDataTransfer {
  private readonly data = new Map<string, string>();
  get types() {
    return [...this.data.keys()];
  }
  files = [] as File[];
  items = [] as unknown[];
  setData(type: string, value: string) {
    this.data.set(type, value);
  }
  getData(type: string) {
    return this.data.get(type) ?? "";
  }
}
class TestClipboardEvent extends Event {
  clipboardData: TestDataTransfer | null;
  constructor(type: string, init: EventInit & { clipboardData?: TestDataTransfer } = {}) {
    super(type, init);
    this.clipboardData = init.clipboardData ?? null;
  }
}
const g = globalThis as Record<string, unknown>;
g.DataTransfer ??= TestDataTransfer;
g.ClipboardEvent ??= TestClipboardEvent;

describe("what a guest writes, in the owner's editor", () => {
  it("a javascript: link and a hostile paste run nothing and open nothing", async () => {
    let editor: AnyEditor | null = null;
    const opened = vi.spyOn(window, "open").mockImplementation(() => null);
    (window as unknown as { __pwned?: number }).__pwned = undefined;
    render(
      <EditorKitProvider value={{ theme: "light" }}>
        <EditorAdaptersProvider adapters={{}}>
          <DocumentEditor documentName="hostile" editable initialMarkdown="Hello" onEditor={(e) => (editor = e)} />
        </EditorAdaptersProvider>
      </EditorKitProvider>,
    );
    await waitFor(() => expect(editor).not.toBeNull());
    // As a guest's socket delivers it: a block whose text is a link to a script.
    act(() => {
      editor!.insertBlocks(
        [{ type: "paragraph", content: [{ type: "link", href: "javascript:window.__pwned=1", content: [{ type: "text", text: "click me", styles: {} }] }] } as never],
        editor!.document[0]!,
        "after",
      );
    });
    // And a paste from the guest's clipboard.
    act(() => {
      editor!.pasteHTML('<p><a href="javascript:window.__pwned=2">pasted</a><img src="x" onerror="window.__pwned=3"><script>window.__pwned=4</script></p>');
    });
    await new Promise((r) => setTimeout(r, 50));
    const root = document.querySelector(".ProseMirror")!;
    // Both reached the text: the guest's words are there, what they would run is not.
    expect(root.textContent).toContain("click me");
    expect(root.textContent).toContain("pasted");
    for (const a of root.querySelectorAll("a")) expect(a.getAttribute("href") ?? "").not.toMatch(/^\s*javascript:/i);
    for (const el of root.querySelectorAll("*")) for (const attr of el.getAttributeNames()) expect(attr.startsWith("on"), `${el.tagName} ${attr}`).toBe(false);
    expect(root.querySelector("script")).toBeNull();
    // A press on the link opens nothing: the editor takes every press, and a script is no address.
    const link = [...root.querySelectorAll("a")].find((a) => a.textContent === "click me");
    if (link) fireEvent.click(link, { metaKey: true });
    expect(opened).not.toHaveBeenCalled();
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
  });
});
