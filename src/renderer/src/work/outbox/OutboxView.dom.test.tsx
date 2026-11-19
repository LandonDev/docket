// @vitest-environment jsdom
/**
 * The Outbox (docs/agents/work-outbox.md, "The screens") over two hosts
 * that answer from memory as `work.outbox.*` does: one list under each
 * workspace, the payload exactly as it goes, Edit, Send, Discard, a
 * group's Send N, a grant made from an item and removed, and Sent with who
 * pressed and when.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OutboxGrant, OutboxItem } from "@shared/contract-work-outbox";

type Call = { env: string; method: string; params: Record<string, unknown> };
const world = vi.hoisted(() => ({
  calls: [] as Call[],
  items: new Map<string, OutboxItem[]>(),
  grants: new Map<string, OutboxGrant[]>(),
  resultsDown: false,
}));

vi.mock("../../lib/connection", async (original) => {
  const link = (env: string) => ({
    environmentId: env,
    connected: true,
    onPush: () => () => undefined,
    onOpen: () => () => undefined,
    onClose: () => () => undefined,
    request: async (method: string, params: Record<string, unknown> = {}) => {
      world.calls.push({ env, method, params });
      const items = world.items.get(env) ?? [];
      const find = () => items.find((i) => i.ref.id === (params.ref as { id: string }).id)!;
      const now = Date.now();
      switch (method) {
        case "work.outbox.list": {
          const waiting = items.filter((i) => ["held", "live", "failed", "sending"].includes(i.state));
          return { items: params.show === "decided" ? items.filter((i) => i.state === "sent" || i.state === "discarded") : waiting, waiting: waiting.length };
        }
        case "work.outbox.grants":
          return { grants: (world.grants.get(env) ?? []).filter((g) => !g.removedAt) };
        case "work.outbox.send":
          // as the host: a row another press decided first is answered as it stands, and nothing runs
          if (!["held", "live", "failed"].includes(find().state)) return find();
          Object.assign(find(), { state: "sent", decidedBy: "owner", decidedAt: now, updatedAt: now });
          return find();
        case "work.outbox.discard":
          Object.assign(find(), { state: "discarded", decidedBy: "owner", decidedAt: now });
          return find();
        case "work.outbox.edit":
          Object.assign(find(), { payload: params.payload, updatedAt: now });
          return find();
        case "work.outbox.grant": {
          const grant = { id: `g${now}`, workspaceId: "ws1", kind: "mail.send", matcher: params.matcher, label: String(params.label), madeFrom: params.from, routineId: null, createdAt: now, removedAt: null } as OutboxGrant;
          world.grants.set(env, [...(world.grants.get(env) ?? []), grant]);
          return grant;
        }
        case "work.outbox.ungrant": {
          const grant = (world.grants.get(env) ?? []).find((g) => g.id === params.id)!;
          grant.removedAt = now;
          return grant;
        }
        case "work.outbox.results":
          if (world.resultsDown) throw new Error("The host did not answer");
          return { results: [] };
        case "work.outbox.get":
          return { ...find(), payload: { ...(find().payload as object), picture: { mimeType: "image/png", width: 16, height: 10, data: "AAAA" } } };
      }
      throw new Error(`unknown ${method}`);
    },
  });
  const links = { box: link("box"), mac: link("mac") };
  return {
    ...(await original<typeof import("../../lib/connection")>()),
    registry: {
      linkOf: (env: "box" | "mac") => links[env],
      onLink: (listener: (l: ReturnType<typeof link>, event: string) => void) => {
        listener(links.box, "added");
        listener(links.mac, "added");
        return () => undefined;
      },
    },
  };
});

vi.mock("../../chrome/WindowControls", () => ({ WindowControls: () => null }));

import { setWorkOn, workSwitch } from "../../lib/workSwitch";
import { canEdit, OutboxView } from "./OutboxView";
import { resetOutboxStore } from "./store";

const mail = (id: string, to: string, subject: string, extra: Partial<OutboxItem> = {}): OutboxItem => ({
  ref: { at: "lifeos", table: "outbox", id },
  kind: "mail.send",
  workspaceId: "ws1",
  sessionId: "t1",
  sector: "purdue",
  summary: `Send to ${to}: ${subject}`,
  verb: "Send",
  account: "landon@purdue.edu",
  state: "held",
  payload: { id, status: "draft", message: { kind: "mail", accountId: "acc", to: [{ name: to, address: `${to.split(" ")[0]!.toLowerCase()}@purdue.edu` }], cc: [], bcc: [], subject, html: `<p>Hello ${to},</p><p>About ${subject}.</p><p>Landon</p>`, text: `Hello ${to},\n\nAbout ${subject}.\n\nLandon` } },
  createdAt: 1_000 + Number(id.replace(/\D/g, "")),
  decidedBy: null,
  decidedAt: null,
  n: null,
  why: "lifeos",
  grantId: null,
  error: null,
  result: null,
  routineRunId: null,
  updatedAt: 500,
  ...extra,
});
const addonCall: OutboxItem = {
  ...mail("h9", "x", "y"),
  ref: { at: "host", id: "h9" },
  kind: "addon.call",
  workspaceId: "ws2",
  sector: "unify",
  summary: "Post message with Slack: “Spring LAN is set”",
  verb: "Send",
  why: "rule",
  n: 1,
  payload: { addonId: "a1", addon: "Slack", tool: "post_message", words: "Post message", arguments: { channel: "staff", text: "Spring LAN is set" }, specDigest: "d" },
};

beforeEach(() => {
  world.calls = [];
  world.items = new Map([
    ["box", [mail("o1", "Dana Lee", "Budget"), mail("o2", "Sam Ortiz", "Scrims"), mail("o3", "Events booking", "Ballroom")]],
    // a copy: a press marks the host's row sent, and the next test must find it held again
    ["mac", [{ ...addonCall }]],
  ]);
  world.grants = new Map();
  world.resultsDown = false;
  workSwitch.reset();
  setWorkOn("box", true);
  setWorkOn("mac", true);
  resetOutboxStore();
});
afterEach(cleanup);

async function open() {
  render(<OutboxView besideRail onClose={() => undefined} />);
  // the page keeps the tab it was left on; each test starts on Waiting
  fireEvent.click(screen.getByRole("tab", { name: "Waiting" }));
  await waitFor(() => expect(screen.getAllByText("Send to Dana Lee").length).toBeGreaterThan(0));
}
const sends = () => world.calls.filter((c) => c.method === "work.outbox.send");

describe("the Outbox", () => {
  it("lists every host's held acts under their workspace, and shows exactly what goes", async () => {
    await open();
    expect(screen.getAllByRole("region").map((r) => r.getAttribute("aria-label"))).toEqual(["Outbox", "A Work workspace", "A Work workspace"]);
    // the first is open: mail's own view (milestone 23), its fields and its body as plain text
    await waitFor(() => expect([...document.querySelectorAll("dd")].map((d) => d.textContent)).toContain("Dana Lee dana@purdue.edu"));
    expect(screen.getByText(/About Budget\./)).toBeTruthy();
    fireEvent.click(screen.getByText("Post message with Slack"));
    expect(screen.getByText("staff")).toBeTruthy();
  });

  it("sends a LifeOS draft with the updatedAt it was shown with, through the host that holds it", async () => {
    await open();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Send" })));
    expect(sends()).toEqual([{ env: "box", method: "work.outbox.send", params: { ref: { at: "lifeos", table: "outbox", id: "o1" }, rev: 500 } }]);
    await waitFor(() => expect(screen.queryAllByText("Send to Dana Lee")).toEqual([]));
  });

  it("discards, and edits what goes while it waits", async () => {
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Subject"), { target: { value: "Budget, second draft" } });
    await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: "Save" })));
    const edit = world.calls.find((c) => c.method === "work.outbox.edit")!;
    expect((edit.params.payload as { message: { subject: string } }).message.subject).toBe("Budget, second draft");
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Discard" })));
    expect(world.calls.filter((c) => c.method === "work.outbox.discard").map((c) => c.params.ref)).toEqual([{ at: "lifeos", table: "outbox", id: "o1" }]);
  });

  it("a workspace's Send 3 sends its three, and nothing of another workspace", async () => {
    await open();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Send 3" })));
    expect(sends().map((c) => [c.env, (c.params.ref as { id: string }).id])).toEqual([
      ["box", "o1"],
      ["box", "o2"],
      ["box", "o3"],
    ]);
  });

  it("a send that may have gone offers no plain Send: a line to check Sent, his own Send again, and no group or tick takes it", async () => {
    world.items.set("box", [mail("o1", "Dana Lee", "Budget", { state: "failed", error: "Outlook did not answer in time", outcomeUnknown: true }), mail("o2", "Sam Ortiz", "Scrims"), mail("o3", "Events booking", "Ballroom")]);
    await open();
    await waitFor(() => expect(screen.getByText("Check Sent first")).toBeTruthy());
    expect(screen.queryByRole("button", { name: "More ways to send" })).toBeNull();
    expect(screen.queryByRole("checkbox", { name: "Tick Send to Dana Lee" })).toBeNull();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Send 2" })));
    expect(sends().map((c) => (c.params.ref as { id: string }).id)).toEqual(["o2", "o3"]);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Send again" })));
    expect(sends().at(-1)!.params).toEqual({ ref: { at: "lifeos", table: "outbox", id: "o1" }, rev: 500, again: true });
  });

  it("ticked rows send together", async () => {
    await open();
    fireEvent.click(screen.getByRole("checkbox", { name: "Tick Send to Sam Ortiz" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Tick Post message with Slack" }));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Send 2" })));
    expect(sends().map((c) => [c.env, (c.params.ref as { id: string }).id]).sort()).toEqual([
      ["box", "o2"],
      ["mac", "h9"],
    ]);
  });

  it("makes a grant only from an item's Send menu, lists it, and removes it", async () => {
    await open();
    fireEvent.click(screen.getByRole("button", { name: "More ways to send" }));
    await act(async () => fireEvent.click(await screen.findByRole("menuitem", { name: "Mail to Dana Lee" })));
    expect(world.calls.find((c) => c.method === "work.outbox.grant")!.params).toEqual({ from: { at: "lifeos", table: "outbox", id: "o1" }, matcher: { accountId: "acc", recipients: ["dana@purdue.edu"] }, label: "Mail to Dana Lee" });
    expect(sends()).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Grants" }));
    const sheet = await screen.findByRole("dialog");
    await waitFor(() => expect(within(sheet).getByText("Mail to Dana Lee")).toBeTruthy());
    await act(async () => fireEvent.click(within(sheet).getByRole("button", { name: "Remove" })));
    expect(world.calls.filter((c) => c.method === "work.outbox.ungrant")).toHaveLength(1);
    await waitFor(() => expect(within(sheet).getByText("No grants. Every act waits for your press.")).toBeTruthy());
  });

  it("puts what left under Sent, with who pressed and when", async () => {
    await open();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Send" })));
    fireEvent.click(screen.getByRole("tab", { name: "Sent" }));
    await waitFor(() => expect(screen.getAllByText("Sent to Dana Lee").length).toBeGreaterThan(0));
    expect(screen.getByText(/Sent by you at/)).toBeTruthy();
    expect(screen.getByText("Sent mail cannot be taken back")).toBeTruthy();
  });

  it("when the item he reads is decided elsewhere, the detail empties rather than slide the next one under Send", async () => {
    await open();
    world.items.get("box")![0]!.state = "discarded";
    const { loadOutbox } = await import("./store");
    await act(async () => loadOutbox());
    await waitFor(() => expect(screen.getByText("No longer waiting")).toBeTruthy());
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
  });

  it("a press the host answers with another decision is not called sent", async () => {
    await open();
    world.items.get("box")![0]!.state = "discarded";
    const { loadToast } = await import("../../components/ui/toaster");
    const toast = await loadToast();
    const error = vi.spyOn(toast, "error");
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Send" })));
    expect(error).toHaveBeenCalledWith("Already discarded");
  });

  it("never draws Held in amber: no waiting mark anywhere on the page", async () => {
    await open();
    expect(document.querySelector('[data-state="waiting"]')).toBeNull();
  });

  it("says the detail's facts as one comma sentence, never with a middle dot", async () => {
    await open();
    const facts = document.querySelector("header [data-slot=facts]") as HTMLElement;
    expect(facts).toBeTruthy();
    expect(facts.closest("header")!.textContent).not.toContain("·");
  });

  it("names a held item's workspace in its head only in the narrow stack, where the list's heading is gone", async () => {
    await open();
    const [wide, narrow] = [...document.querySelectorAll("header [data-slot=facts]")] as HTMLElement[];
    expect(wide!.className).toContain("@max-[40rem]/outbox:hidden");
    expect(wide!.textContent).not.toContain("A Work workspace");
    expect(narrow!.className).toContain("@max-[40rem]/outbox:inline-flex");
    expect(narrow!.textContent).toContain("A Work workspace");
  });

  it("says a rewrite waits once, in the mail's own view, not again over it", async () => {
    world.items.set("box", [mail("o1", "Dana Lee", "Budget", { proposed: true } as Partial<OutboxItem>)]);
    await open();
    expect(screen.queryByText("An agent's rewrite waits in this draft; what shows is what goes.")).toBeNull();
  });

  it("offers Edit only where something can change", async () => {
    expect(canEdit(mail("o1", "Dana Lee", "Budget"))).toBe(true);
    expect(canEdit({ state: "live", payload: { title: "Click Send", app: "Mail" } })).toBe(false);
    expect(canEdit({ state: "held", payload: { id: "x", html: "<p>Only html</p>" } })).toBe(false);
    world.items.set("box", [mail("o1", "Dana Lee", "Budget", { state: "live" })]);
    await open();
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
  });

  it("names the host whose screen a computer act takes, and keeps its picture in Sent", async () => {
    const click: OutboxItem = { ...addonCall, state: "held", ref: { at: "host", id: "c1" }, kind: "computer.act", summary: "Click Send in Mail", payload: { title: "Click Send in Mail", app: "Mail", picture: { mimeType: "image/png", width: 16, height: 10 } } };
    // The last test's press reloads its host as it ends: let that land before this world is read.
    await act(async () => void (await new Promise((r) => setTimeout(r, 0))));
    world.items.set("mac", [click]);
    world.items.set("box", []);
    resetOutboxStore();
    render(<OutboxView besideRail onClose={() => undefined} />);
    fireEvent.click(screen.getByRole("tab", { name: "Waiting" }));
    await waitFor(() => expect(screen.getAllByText("Click Send in Mail").length).toBeGreaterThan(0));
    await waitFor(() => expect(screen.getByText(/screen for a moment\./)).toBeTruthy());
    expect(screen.queryByText(/this host's screen/)).toBeNull();
    // Held, the picture he approves sits above the verbs.
    const held = (await screen.findByRole("img")) as HTMLImageElement;
    expect(held.src).toBe("data:image/png;base64,AAAA");
    expect(held.compareDocumentPosition(screen.getByRole("button", { name: "Send" })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Send" })));
    fireEvent.click(screen.getByRole("tab", { name: "Sent" }));
    const picture = (await screen.findByRole("img")) as HTMLImageElement;
    expect(picture.src).toBe("data:image/png;base64,AAAA");
    expect(world.calls.some((c) => c.method === "work.outbox.get")).toBe(true);
  });

  it("keeps a failed read of the Results apart from an act with no way back, with Retry", async () => {
    world.resultsDown = true;
    await open();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Send" })));
    fireEvent.click(screen.getByRole("tab", { name: "Sent" }));
    await waitFor(() => expect(screen.getByText("The host did not answer")).toBeTruthy());
    expect(screen.queryByText("Sent mail cannot be taken back")).toBeNull();
    world.resultsDown = false;
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Retry" })));
    await waitFor(() => expect(screen.getByText("Sent mail cannot be taken back")).toBeTruthy());
  });

  it("narrow, shows the list until he picks an item, then the detail with a way back", async () => {
    await open();
    const list = document.querySelector("[data-outbox-list]") as HTMLElement;
    const detail = () => document.querySelector("[data-outbox-detail]") as HTMLElement;
    expect(detail().className).toContain("@max-[40rem]/outbox:hidden");
    fireEvent.click(await screen.findByText("Post message with Slack"));
    expect(list.className).toContain("@max-[40rem]/outbox:hidden");
    expect(detail().className).not.toContain("@max-[40rem]/outbox:hidden");
    fireEvent.click(within(detail()).getByRole("button", { name: "Waiting" }));
    expect(list.className).not.toContain("@max-[40rem]/outbox:hidden");
  });
});
