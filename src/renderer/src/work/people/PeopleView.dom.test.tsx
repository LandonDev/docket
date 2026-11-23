// @vitest-environment jsdom
/**
 * A Work workspace's People: the sector's people from LifeOS (`people:directory`), one person's
 * page (`people:page`, asked about the guest links named for them), and the ways in: a sender in
 * Mail by address, an attendee in Agenda, a sent person chip. LifeOS and the host stand in.
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ContextChip } from "@shared/work";
import { openWorkView, workViewNow } from "../../lib/workSwitch";
import type { WorkViewProps } from "../views/registry";

if (!Element.prototype.getAnimations) Element.prototype.getAnimations = () => [];

const NOW = Date.now();
const lifeos = vi.hoisted(() => ({ asked: [] as { name: string; args: Record<string, unknown> }[], page: null as unknown, directoryFails: false }));
const directory = [
  { _id: "p_maya", name: "Maya Chen", emails: ["maya@school.edu"], lastAt: Date.now() - 3_600_000 },
  { _id: "p_tom", name: "Tom Beck", emails: ["tom@school.edu"] },
];
vi.mock("../shell/lifeos", async (original) => ({
  ...(await original<object>()),
  useLifeosQuery: (_session: unknown, name: string, args: Record<string, unknown>) => {
    lifeos.asked.push({ name, args });
    if (name === "people:directory") return lifeos.directoryFails ? { status: "failed", error: "LifeOS refused" } : { status: "ready", value: directory };
    if (name === "mail:faces") return { status: "ready", value: [] };
    if (name === "people:page") return { status: "ready", value: lifeos.page };
    return { status: "loading" };
  },
}));
const host = vi.hoisted(() => ({ links: [] as unknown[] }));
vi.mock("../guests/api", async (original) => ({ ...(await original<object>()), guestsCall: async () => ({ env: "box", value: host.links }) }));
const mail = vi.hoisted(() => ({ drafts: [] as unknown[] }));
vi.mock("../mail/mailto", async (original) => ({ ...(await original<object>()), writeMail: (d: unknown) => void mail.drafts.push(d) }));

const { View, Head, Title, placeOf, setPlace } = await import("./PeopleView");
const { openerOf } = await import("../canvas/SentChips");

const mayaPage = {
  person: { _id: "p_maya", name: "Maya Chen", notes: "Runs the front desk.", sectors: ["purdue"], emails: ["maya@school.edu"], phones: [] },
  mail: [{ _id: "mt1", subject: "Bracket for Friday", snippet: "Here it is", lastMessageAt: NOW, unread: true }],
  coming: [{ _id: "ev1", title: "Tryouts", startsAt: NOW + 86_400_000, location: "Arena" }],
  recent: [],
  tasks: [
    { _id: "t1", title: "Send the bracket", status: "todo", relation: "asked" },
    { _id: "t2", title: "Seat list", status: "todo", relation: "waiting" },
  ],
  shared: [
    { table: "docs", id: "d1", title: "Run of show" },
    { table: "sheets", id: "s1", title: "Budget" },
  ],
};

let started: ContextChip[];
const props = (): WorkViewProps =>
  ({ env: "box", workspace: { id: "ws", environmentId: "box" }, sector: "purdue", lifeos: { client: {}, state: "connected" }, startThread: (c: ContextChip) => void started.push(c) }) as never;
const mount = () =>
  render(
    <>
      <div data-testid="title">
        <Title {...props()} />
      </div>
      <div data-testid="head">
        <Head {...props()} />
      </div>
      <View {...props()} />
    </>,
  );

beforeEach(() => {
  started = [];
  lifeos.asked = [];
  lifeos.page = mayaPage;
  lifeos.directoryFails = false;
  host.links = [];
  mail.drafts = [];
  setPlace("ws", { person: null, query: "" });
});
afterEach(() => {
  cleanup();
  openWorkView(null);
});

describe("the list", () => {
  it("lists the sector's people in LifeOS's order with their address, and searches them", async () => {
    mount();
    expect(lifeos.asked).toContainEqual({ name: "people:directory", args: { sector: "purdue" } });
    const rows = screen.getAllByRole("listitem");
    // Each row: the face (initials here), the name, the address, and when they were last heard from.
    expect(rows.map((r) => r.textContent)).toEqual([expect.stringMatching(/^MCMaya Chenmaya@school.edu(\d|Yesterday)/), "TBTom Becktom@school.edu"]);
    fireEvent.change(screen.getByLabelText("Search people"), { target: { value: "tom" } });
    expect(screen.getAllByRole("listitem").map((r) => r.textContent)).toEqual(["TBTom Becktom@school.edu"]);
    fireEvent.change(screen.getByLabelText("Search people"), { target: { value: "nobody" } });
    expect(screen.getByText("No matches")).toBeTruthy();
    // The empty state's Clear search, beside the field's own ×.
    fireEvent.click(screen.getAllByRole("button", { name: "Clear search" }).at(-1)!);
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
  });

  it("says when the list did not load", () => {
    lifeos.directoryFails = true;
    mount();
    expect(screen.getByText("People did not load")).toBeTruthy();
  });
});

describe("a person's page", () => {
  it("opens from the list: who they are, then each kind of thing live with them, once", async () => {
    host.links = [{ id: "g1", name: "maya chen", source: { at: "lifeos", table: "docs", id: "d1" }, title: "Run of show", role: "comment", createdAt: 1, expiresAt: NOW + 86_400_000, revokedAt: null, by: "owner", lastOpenedAt: null, open: 0 }];
    mount();
    fireEvent.click(screen.getByText("Maya Chen"));
    await act(async () => {});
    expect(lifeos.asked).toContainEqual({ name: "people:page", args: { id: "p_maya", sector: "purdue", shared: [{ table: "docs", id: "d1" }] } });
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Maya Chen");
    expect(screen.getByText("Runs the front desk.")).toBeTruthy();
    expect(screen.getAllByRole("region").map((s) => s.getAttribute("aria-label"))).toEqual(["Mail", "Coming up", "Asked for by them", "Waiting on them", "Shared with them"]);
    expect(screen.getByText(/^Can comment until/)).toBeTruthy();
    // The header: the way back with whose page it is, and the page's two verbs.
    expect(screen.getByTestId("title").textContent).toBe("PeopleMaya Chen");
    expect([...screen.getByTestId("head").querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Write", "New thread"]);
    fireEvent.click(screen.getByRole("button", { name: "Back to People" }));
    expect(placeOf("ws").person).toBeNull();
  });

  it("opens each row where that thing lives", async () => {
    setPlace("ws", { person: "p_maya" });
    mount();
    await act(async () => {});
    const press = (text: string) => fireEvent.click(screen.getByText(text));
    press("Bracket for Friday");
    expect(workViewNow()).toEqual({ workspaceId: "ws", view: "mail", mail: "mt1" });
    press("Tryouts");
    expect(workViewNow()).toEqual({ workspaceId: "ws", view: "agenda", event: "ev1" });
    press("Seat list");
    expect(workViewNow()).toEqual({ workspaceId: "ws", view: "tasks", task: "t2" });
    press("Run of show");
    expect(workViewNow()).toEqual({ workspaceId: "ws", view: "docs", doc: { id: "d1", title: "Run of show" } });
    press("Budget");
    expect(started).toEqual([{ kind: "selection", label: "Budget", ref: { at: "lifeos", table: "sheets", id: "s1" } }]);
  });

  it("Write opens Mail with a new mail to them; New thread starts one about them; nothing is sent", async () => {
    setPlace("ws", { person: "p_maya" });
    mount();
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "Write" }));
    expect(mail.drafts).toEqual([{ to: ["maya@school.edu"], cc: [], bcc: [], subject: "", body: "" }]);
    expect(workViewNow()).toEqual({ workspaceId: "ws", view: "mail" });
    fireEvent.click(screen.getByRole("button", { name: "New thread" }));
    expect(started).toEqual([{ kind: "person", label: "Maya Chen", ref: { at: "lifeos", table: "people", id: "p_maya" } }]);
  });

  it("says when nothing is live with them, and when they are not one of the sector's people", async () => {
    lifeos.page = { ...mayaPage, mail: [], coming: [], tasks: [], shared: [], person: { ...mayaPage.person, notes: "" } };
    setPlace("ws", { person: "p_maya" });
    const first = mount();
    await act(async () => {});
    expect(screen.getByText("Nothing live with them here.")).toBeTruthy();
    first.unmount();
    lifeos.page = null;
    mount();
    await act(async () => {});
    expect(screen.getByText("Not in People here")).toBeTruthy();
  });
});

describe("the ways in", () => {
  it("a sender's address from Mail opens their page; an address no one here has is put in the search", async () => {
    openWorkView({ workspaceId: "ws", view: "people", person: "MAYA@school.edu" });
    mount();
    await act(async () => {});
    expect(placeOf("ws").person).toBe("p_maya");
    expect(workViewNow()).toEqual({ workspaceId: "ws", view: "people" });
    cleanup();
    setPlace("ws", { person: null });
    openWorkView({ workspaceId: "ws", view: "people", person: "stranger@else.org" });
    mount();
    await act(async () => {});
    expect(placeOf("ws")).toEqual({ person: null, query: "stranger@else.org" });
  });

  it("a sent person chip opens their page", () => {
    const opener = openerOf({ noun: "person", label: "Maya Chen", ref: "LifeOS people p_maya" } as never, { environmentId: "box", sessionId: "s", workspaceId: "ws" });
    void opener!();
    expect(workViewNow()).toEqual({ workspaceId: "ws", view: "people", person: "p_maya" });
  });
});
