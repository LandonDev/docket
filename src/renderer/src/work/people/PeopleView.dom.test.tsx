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

const NOW = new Date(2026, 10, 23, 12).getTime();
const lifeos = vi.hoisted(() => ({ asked: [] as { name: string; args: Record<string, unknown> }[], page: null as unknown, directoryFails: false, pageFails: false, once: [] as { args: unknown; answer(): void; fail(e: Error): void }[] }));
const directory = [
  { _id: "p_maya", name: "Maya Chen", emails: ["maya@school.edu"], lastAt: NOW - 3_600_000 },
  { _id: "p_tom", name: "Tom Beck", emails: ["tom@school.edu"] },
];
vi.mock("../shell/lifeos", async (original) => ({
  ...(await original<object>()),
  useLifeosQuery: (_session: unknown, name: string, args: Record<string, unknown>) => {
    lifeos.asked.push({ name, args });
    if (name === "people:directory") return lifeos.directoryFails ? { status: "failed", error: "LifeOS refused" } : { status: "ready", value: directory };
    if (name === "mail:faces") return { status: "ready", value: [] };
    if (name === "people:page") return lifeos.pageFails ? { status: "failed", error: "LifeOS refused the page" } : { status: "ready", value: lifeos.page };
    return { status: "loading" };
  },
}));
const host = vi.hoisted(() => ({ links: [] as unknown[], calls: [] as unknown[][] }));
vi.mock("../guests/api", async (original) => ({ ...(await original<object>()), guestsCall: async (...args: unknown[]) => (host.calls.push(args), { env: "box", value: host.links }) }));
const mail = vi.hoisted(() => ({ drafts: [] as unknown[] }));
vi.mock("../mail/mailto", async (original) => ({ ...(await original<object>()), writeMail: (d: unknown) => void mail.drafts.push(d) }));
const files = vi.hoisted(() => ({ docs: [] as unknown[][], opened: [] as unknown[][] }));
vi.mock("../files/openFrom", () => ({ openDocInFiles: async (...args: unknown[]) => void files.docs.push(args), openInFiles: async (...args: unknown[]) => void files.opened.push(args) }));
const forms = vi.hoisted(() => ({ asked: [] as unknown[][], answered: [] as unknown[] }));
vi.mock("../msforms/answered", () => ({ readAnswered: async (...args: unknown[]) => (forms.asked.push(args), forms.answered) }));

const { View, Head, Title, placeOf, setPlace, forgetGuestLinks } = await import("./PeopleView");
const { openerOf } = await import("../canvas/SentChips");
const { keepPlace } = await import("../shell/place");

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
  ({ env: "box", workspace: { id: "ws", environmentId: "box" }, sector: "purdue", lifeos: { client: { query: (_ref: unknown, args: unknown) => new Promise<void>((answer, fail) => void lifeos.once.push({ args, answer, fail })) }, state: "connected" }, startThread: (c: ContextChip) => void started.push(c) }) as never;
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
  forgetGuestLinks();
  vi.setSystemTime(NOW);
  started = [];
  lifeos.asked = [];
  lifeos.page = mayaPage;
  lifeos.directoryFails = false;
  host.links = [];
  mail.drafts = [];
  forms.asked = [];
  forms.answered = [];
  files.opened = [];
  setPlace("ws", { person: null, query: "" });
});
afterEach(() => {
  vi.useRealTimers();
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
    lifeos.directoryFails = false;
  });

  /** Council round 12 (the walk): People did not load had no Retry. */
  it("reads the list again on Retry, the failure kept and Retry spinning until LifeOS answers", async () => {
    lifeos.directoryFails = true;
    lifeos.once.length = 0;
    try {
      mount();
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
      expect(lifeos.once.map((o) => o.args)).toEqual([{ sector: "purdue" }]);
      expect(screen.getByText("People did not load")).toBeTruthy();
      expect(screen.getByRole("button", { name: "Retry" }).querySelector("[data-busy]")).not.toBeNull();
      // Refused again: its words in place, Retry at rest.
      await act(async () => lifeos.once[0].fail(new Error("LifeOS still refused")));
      expect(screen.getByText("LifeOS still refused")).toBeTruthy();
      expect(screen.getByRole("button", { name: "Retry" }).querySelector("[data-busy]")).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
      lifeos.directoryFails = false;
      await act(async () => lifeos.once[1].answer());
      expect(screen.queryByText("People did not load")).toBeNull();
      expect(screen.getAllByRole("listitem")).toHaveLength(2);
    } finally {
      lifeos.directoryFails = false;
    }
  });
});

describe("a person's page", () => {
  it("asks LifeOS for the page once, with the links in hand, and the host for the links once for two people opened one after another", async () => {
    forgetGuestLinks();
    host.calls.length = 0;
    host.links = [];
    lifeos.page = mayaPage;
    mount();
    fireEvent.click(screen.getByText("Maya Chen"));
    await act(async () => {});
    const pages = () => lifeos.asked.filter((a) => a.name === "people:page");
    // Every render asks the stand-in again; the page is only ever asked with the links in hand, never with none first.
    expect(pages().length).toBeGreaterThan(0);
    expect(new Set(pages().map((a) => JSON.stringify(a.args.shared)))).toEqual(new Set(["[]"]));
    expect(host.calls.length).toBe(1);
    act(() => setPlace("ws", { person: "p_tom" }));
    await act(async () => {});
    expect(host.calls.length).toBe(1);
  });

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

  it("lists the job's Microsoft forms they answered, last, each opening the form in its Files tab", async () => {
    forms.answered = [{ formId: "f1", title: "Spring LAN sign-up", tenant: "purdue0", at: NOW - 3_600_000 }];
    setPlace("ws", { person: "p_maya" });
    mount();
    await act(async () => {});
    expect(forms.asked).toEqual([["box", "ws", ["maya@school.edu"]]]);
    expect(screen.getAllByRole("region").map((s) => s.getAttribute("aria-label")).at(-1)).toBe("Answered");
    fireEvent.click(screen.getByText("Spring LAN sign-up"));
    expect(files.opened).toEqual([[{ id: "ws", environmentId: "box" }, { ref: { at: "msform", host: "box", workspaceId: "ws", formId: "f1", tenant: "purdue0" }, name: "Spring LAN sign-up" }]]);
  });

  /** Council round 12 (the walk): This page did not load had no Retry. */
  it("reads a person's page again on Retry, the failure kept and Retry spinning until LifeOS answers", async () => {
    setPlace("ws", { person: "p_maya" });
    lifeos.page = mayaPage;
    lifeos.pageFails = true;
    lifeos.once.length = 0;
    try {
      mount();
      const retry = await screen.findByRole("button", { name: "Retry" });
      expect(screen.getByText("This page did not load")).toBeTruthy();
      fireEvent.click(retry);
      expect(lifeos.once[0].args).toMatchObject({ id: "p_maya", sector: "purdue" });
      expect(screen.getByRole("button", { name: "Retry" }).querySelector("[data-busy]")).not.toBeNull();
      lifeos.pageFails = false;
      await act(async () => lifeos.once[0].answer());
      expect(screen.queryByText("This page did not load")).toBeNull();
      expect(screen.getAllByText("Maya Chen").length).toBeGreaterThan(0);
    } finally {
      lifeos.pageFails = false;
    }
  });

  /** Council round 5 (Sol rest 1): a kept person's page said "This page did not load" under the frame's own line. */
  it("draws nothing under the frame's line while the session is down, a kept person's page included, and keeps the person", async () => {
    setPlace("ws", { person: "p_maya" });
    const down = { ...props(), lifeos: { environmentId: "box", sector: "purdue", client: null, state: "unreachable", unanswered: true } } as never;
    const { container } = render(
      <>
        <Head {...down} />
        <View {...down} />
      </>,
    );
    await act(async () => {});
    expect(container.textContent).toBe("");
    expect(container.querySelector("button, input")).toBeNull();
    expect(placeOf("ws").person).toBe("p_maya");
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
    // A document opens in a Files tab of its own.
    expect(files.docs).toEqual([["ws", { id: "d1", title: "Run of show" }]]);
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

describe("People coming back", () => {
  const at = (id: string) => ({ ...props(), workspace: { id, environmentId: "box" } }) as never;

  it("opens the page it was left on, and a person gone since gives way to the list, quietly", async () => {
    keepPlace("back", "people", { person: "p_maya" });
    lifeos.page = mayaPage;
    const first = render(<View {...at("back")} />);
    await act(async () => {});
    expect(screen.getByText("Runs the front desk.")).toBeTruthy();
    first.unmount();
    keepPlace("back2", "people", { person: "p_gone" });
    lifeos.page = null;
    render(<View {...at("back2")} />);
    await act(async () => {});
    expect(screen.queryByText("Not in People here")).toBeNull();
    expect(placeOf("back2").person).toBeNull();
  });
});
