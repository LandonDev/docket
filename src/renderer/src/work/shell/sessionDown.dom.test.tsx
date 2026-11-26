// @vitest-environment jsdom
/**
 * Council rounds 5 and 6, the sweep: every reader of a LifeOS session that is down holds to one rule (lifeosDown.ts).
 * It says the state once, in the session's words with the computer named; its one press is `downPress`'s, made only
 * where this window may (`useDownPress`): Retry for silence; Sign in for signed out or refused and Show the code for a
 * sign-in that waits, where this window may sign the host in; Open Settings for Work off where it may turn Work on;
 * else who can; none for a computer kept from LifeOS;
 * and no header press whose dialog needs the session is offered while it is down. Each reader is mounted on a real
 * session, the host faked through the registry, in each down state.
 */
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { registry } from "../../lib/connection";
import { resetLifeos, useLifeosSession } from "./lifeos";
import { downPress, type LifeosDown } from "./lifeosDown";

vi.mock("../../lib/tcserver/workspaces", async (original) => ({
  ...(await original<object>()),
  useWorkspaces: () => [{ id: "ws", name: "Purdue Esports", environmentId: "env_box", sector: "purdue", kind: "work", path: "/w" }],
}));
vi.mock("convex/react", async (original) => ({
  ...(await original<object>()),
  ConvexReactClient: class {
    url = "https://lifeos.test";
    setAuth(): void {}
    close(): Promise<void> {
      return Promise.resolve();
    }
  },
}));
vi.mock("../../stores/project", async (original) => ({ ...(await original<object>()), useSelectedWorkspaceIds: () => ["ws"] }));
const toasts = vi.hoisted(() => [] as string[]);
vi.mock("../../components/ui/toaster", () => {
  const toast = Object.assign(() => undefined, { error: (message: string) => void toasts.push(message) });
  return { loadToast: async () => toast, toast };
});

const { ViewFrame } = await import("./WorkViewPage");
const { DownLine } = await import("./DownLine");
const { LifeosLine } = await import("../connections/LifeosLine");
const { View: ChatReply } = await import("../messages/ChatReplyAct");
const { View: CalendarAct } = await import("../agenda/CalendarActView");
const { PageVerbs } = await import("../prep/PrepView");
const { TodayPageView } = await import("../today/TodayView");
const { WaitingRows } = await import("../mail/WaitingSection");
const { HeldDetail } = await import("../outbox/HeldDetail");

const NOW = Date.UTC(2026, 10, 24, 17);
const connected = { lifeos: { state: "connected", ownerId: "landon", since: 1 }, keys: [] };
const timeout = () => Object.assign(new Error("No answer in 15 s"), { name: "TimeoutError" });

/** The host's status and the JWT's answer, for each down state. */
const STATES: Record<LifeosDown | "jwt-unanswered" | "connecting", { status: () => Promise<unknown>; jwt?: () => Promise<unknown> }> = {
  unreachable: { status: async () => connected, jwt: () => Promise.reject(new Error("socket closed")) },
  unanswered: { status: () => Promise.reject(timeout()) },
  withheld: { status: async () => connected, jwt: () => Promise.reject(new Error("forbidden: work.lifeos.jwt is not for a given computer")) },
  "signed-out": { status: async () => ({ lifeos: { state: "signed-out" }, keys: [] }) },
  refused: { status: async () => ({ lifeos: { state: "refused", error: "revoked" }, keys: [] }) },
  pairing: { status: async () => ({ lifeos: { state: "pairing", expiresAt: NOW + 600_000 }, keys: [] }) },
  off: { status: async () => ({ lifeos: { state: "off" }, keys: [] }) },
  // Council round 7 (Sol, Mail 1): the status answers, then the session ask runs out of time: the host's silence.
  "jwt-unanswered": { status: async () => connected, jwt: () => Promise.reject(timeout()) },
  // Council round 12: not down, on its way.
  connecting: { status: async () => ({ lifeos: { state: "connecting" }, keys: [] }) },
};

/** What each state says, the box named. */
const WORDS: Record<LifeosDown, string> = {
  unreachable: "LifeOS did not answer the box",
  unanswered: "The box did not answer",
  withheld: "This computer cannot read LifeOS through the box",
  "signed-out": "Not signed in to LifeOS on the box",
  refused: "LifeOS refused the box's sign-in",
  pairing: "The LifeOS sign-in on the box waits for your approval",
  off: "Work is off on the box",
};
const PRESS = { retry: "Retry", "sign-in": "Sign in", code: "Show the code", settings: "Open Settings" } as const;
/** Inside Settings the switch's press is named for the section it opens. */
const IN_SETTINGS = { ...PRESS, settings: "Work" } as const;
const DOWN = (Object.keys(STATES) as (keyof typeof STATES)[]).filter((d): d is LifeosDown => d !== "jwt-unanswered" && d !== "connecting");

let asked: string[] = [];
/** His laptop as a given computer (operate, approve, device): it may not turn Work on for the box. */
const GIVEN = { transport: "open", lastHello: { environmentId: "env_box", contract: 1, caps: ["operate", "approve", "device"], key: { id: "laptop" } } };
function host(down: keyof typeof STATES, status: object = { transport: "open" }): void {
  asked = [];
  vi.spyOn(registry, "environment").mockReturnValue({ id: "env_box", name: "The box" } as never);
  vi.spyOn(registry, "statusOf").mockReturnValue(status as never);
  vi.spyOn(registry, "linkOf").mockReturnValue({
    environmentId: "env_box",
    connected: true,
    onPush: () => () => {},
    onOpen: () => () => {},
    request: vi.fn(async (method: string) => {
      asked.push(method);
      if (method === "work.lifeos.status") return STATES[down].status();
      if (method === "work.lifeos.jwt") return (STATES[down].jwt ?? (() => new Promise(() => {})))();
      return new Promise(() => {});
    }),
  } as never);
}

beforeEach(() => void vi.setSystemTime(NOW));
afterEach(() => {
  cleanup();
  resetLifeos();
  vi.useRealTimers();
  vi.restoreAllMocks();
  toasts.length = 0;
});

/** How many times the page says these words. */
const times = (words: string): number => (document.body.textContent ?? "").split(words).length - 1;
const presses = (root: ParentNode = document.body): string[] => [...root.querySelectorAll("button")].map((b) => b.textContent ?? "");
const settle = async (): Promise<void> => {
  for (let i = 0; i < 4; i++) await act(async () => void (await new Promise((r) => setTimeout(r, 0))));
};

/** A part that takes the session from its parent, mounted on the real one. */
function OnSession({ sector, children }: { sector: "purdue" | null; children: (session: ReturnType<typeof useLifeosSession>) => ReactNode }) {
  return <>{children(useLifeosSession("env_box", sector))}</>;
}

describe.each(DOWN)("a session %s", (down) => {
  const words = WORDS[down];
  const press = downPress(down);

  it("in a part's place (a held act's details, a chat card): the words once, and downPress's one press", async () => {
    host(down);
    const { container } = render(<OnSession sector="purdue">{(session) => <DownLine session={session} />}</OnSession>);
    await waitFor(() => expect(container.querySelector(`[data-session-down="${down}"]`)).toBeTruthy());
    expect(times(words)).toBe(1);
    expect(presses()).toEqual(press ? [PRESS[press]] : []);
  });

  it("in a held chat reply: the session's line in the quote's place, never \"could not be read\" with a Retry that remounts", async () => {
    host(down);
    const item = { kind: "chat.reply", sector: "purdue", payload: { chatId: "c1", source: "slack", chat: "Starboard Games", text: "On it" } };
    render(<ChatReply item={item as never} env="env_box" />);
    await waitFor(() => expect(document.querySelector(`[data-session-down="${down}"]`)).toBeTruthy());
    expect(times(words)).toBe(1);
    expect(document.querySelector("[data-answers]")).toBeNull();
    expect(presses()).toEqual(press ? [PRESS[press]] : []);
    // The hold does not move: the reply's words stand as they go.
    expect(screen.getByText("On it")).toBeTruthy();
  });

  it("in a held calendar act: the session's line once, in the reads' place", async () => {
    host(down);
    const op = { id: "op1", kind: "update", eventId: "ev1", payload: { title: "Review", startsAt: NOW, endsAt: NOW + 3_600_000 } };
    render(<CalendarAct item={{ kind: "calendar.op", payload: op, sector: "purdue" } as never} env="env_box" />);
    await waitFor(() => expect(document.querySelector(`[data-session-down="${down}"]`)).toBeTruthy());
    expect(times(words)).toBe(1);
    expect(presses()).toEqual(press ? [PRESS[press]] : []);
  });

  it("in a settings section (LifeosLine): the words once, with the computer named, and the same press", async () => {
    host(down);
    render(<OnSession sector={null}>{(session) => <LifeosLine session={session} waiting={<span data-waiting />} />}</OnSession>);
    await waitFor(() => expect(document.querySelector("[data-waiting]")).toBeNull());
    await waitFor(() => expect(times(words)).toBe(1));
    expect(presses()).toEqual(press ? [IN_SETTINGS[press]] : []);
  });

  it.each(["tasks", "agenda", "people", "mail"] as const)("in the view frame (%s): said once, no second line under it, and no header press that needs the session", async (view) => {
    host(down);
    render(<ViewFrame view={view} environmentId="env_box" workspaceId="ws" sector="purdue" />);
    await settle();
    // Each view's chunk lands and draws its header and body: give it the time it takes.
    await waitFor(() => expect(document.querySelector("[data-view-heading]")).toBeTruthy(), { timeout: 5000 });
    await settle();
    const region = screen.getByRole("region");
    // Every state is the session's words, the computer named: the frame's sign-in body too (council round 7).
    expect(times(words)).toBe(1);
    expect(document.querySelectorAll("[data-view-state=failed]").length).toBe(down === "unreachable" || down === "unanswered" ? 1 : 0);
    expect(region.textContent).not.toMatch(/did not load/);
    // downPress's press, as every reader has it (the frame's sign-in and code open the sign-in dialog in place).
    expect(presses(region).filter((label) => label === "Retry" || label === "Sign in" || label === "Show the code" || label === "Open Settings")).toEqual(press ? [PRESS[press]] : []);
    // Nothing in the header opens a dialog the body cannot draw now, nor searches a list it cannot show.
    expect(screen.queryByRole("button", { name: /New task|New event/ })).toBeNull();
    expect(region.querySelector('[role="search"]')).toBeNull();
    // Mail's head is its body's, drawn under the session alone: the frame's header stays, with its name.
    if (view === "mail") expect(document.querySelector("[data-view-heading]")?.textContent).toBe("Mail");
  });
});

/** Work off on a window that may not turn Work on there: no press, and who can, in every reader. */
describe("Work off where this window may not turn it on", () => {
  const ELSEWHERE = "Changed from a computer that manages the box";

  it("in a part's place, a held chat reply and a held calendar act: the words once, who can, and no press", async () => {
    host("off", GIVEN);
    const reply = { kind: "chat.reply", sector: "purdue", payload: { chatId: "c1", source: "slack", chat: "Starboard Games", text: "On it" } };
    const op = { id: "op1", kind: "update", eventId: "ev1", payload: { title: "Review", startsAt: NOW, endsAt: NOW + 3_600_000 } };
    for (const part of [
      <OnSession key="line" sector="purdue">{(session) => <DownLine session={session} />}</OnSession>,
      <ChatReply key="reply" item={reply as never} env="env_box" />,
      <CalendarAct key="act" item={{ kind: "calendar.op", payload: op, sector: "purdue" } as never} env="env_box" />,
    ]) {
      const view = render(part);
      await waitFor(() => expect(document.querySelector('[data-session-down="off"]')).toBeTruthy());
      expect(times(WORDS.off)).toBe(1);
      expect(times(ELSEWHERE)).toBe(1);
      expect(presses()).toEqual([]);
      view.unmount();
    }
  });

  it("on Today's page: Open Settings where this window may turn Work on, else who can and no press", async () => {
    const today = () => <TodayPageView model={{ kind: "day", blocks: [{ kind: "lifeos", reach: "off" }], offline: [], keys: [] }} hostName={() => "The box"} lifeosHost="The box" lifeosEnv="env_box" onRetryLifeos={vi.fn()} />;
    host("off");
    const may = render(today());
    expect(times(WORDS.off)).toBe(1);
    expect(presses()).toEqual(["Open Settings"]);
    may.unmount();
    host("off", GIVEN);
    render(today());
    expect(times(WORDS.off)).toBe(1);
    expect(times(ELSEWHERE)).toBe(1);
    expect(presses()).toEqual([]);
  });

  it("in a settings section and the view frame: who can, and no Open Settings", async () => {
    host("off", GIVEN);
    const line = render(<OnSession sector={null}>{(session) => <LifeosLine session={session} waiting={<span data-waiting />} />}</OnSession>);
    await waitFor(() => expect(times(WORDS.off)).toBe(1));
    expect(times(ELSEWHERE)).toBe(1);
    expect(presses()).toEqual([]);
    line.unmount();
    render(<ViewFrame view="tasks" environmentId="env_box" workspaceId="ws" sector="purdue" />);
    await waitFor(() => expect(times(WORDS.off)).toBe(1));
    expect(times(ELSEWHERE)).toBe(1);
    expect(screen.queryByRole("button", { name: "Open Settings" })).toBeNull();
  });
});

/**
 * Council round 6: a sign-in missing, refused or waiting, on a window that may sign the host in (no key: the owner's
 * own) and on one that may not (a given computer, whose key may not start the pairing, `work.lifeos.pairStart`):
 * Sign in or Show the code where it may, else who can and no press, in every reader alike.
 */
describe.each(["signed-out", "refused", "pairing"] as const)("a sign-in %s", (down) => {
  // Who can, said by the act (council round 7): nothing was changed.
  const ELSEWHERE = "Sign in from a computer that manages the box";
  const reply = { kind: "chat.reply", sector: "purdue", payload: { chatId: "c1", source: "slack", chat: "Starboard Games", text: "On it" } };
  const op = { id: "op1", kind: "update", eventId: "ev1", payload: { title: "Review", startsAt: NOW, endsAt: NOW + 3_600_000 } };
  const parts = () => [
    <OnSession key="line" sector="purdue">{(session) => <DownLine session={session} />}</OnSession>,
    <ChatReply key="reply" item={reply as never} env="env_box" />,
    <CalendarAct key="act" item={{ kind: "calendar.op", payload: op, sector: "purdue" } as never} env="env_box" />,
  ];
  const label = PRESS[downPress(down)!];

  it.each([
    ["may", { transport: "open" }],
    ["may not", GIVEN],
  ] as const)("in a part's place, a held chat reply and a held calendar act, on a window that %s", async (may, status) => {
    host(down, status);
    for (const part of parts()) {
      const view = render(part);
      await waitFor(() => expect(document.querySelector(`[data-session-down="${down}"]`)).toBeTruthy());
      expect(times(WORDS[down])).toBe(1);
      expect(presses()).toEqual(may === "may" ? [label] : []);
      expect(times(ELSEWHERE)).toBe(may === "may" ? 0 : 1);
      view.unmount();
    }
  });

  it.each([
    ["may", { transport: "open" }],
    ["may not", GIVEN],
  ] as const)("in a settings section, the view frame and Today, on a window that %s", async (may, status) => {
    host(down, status);
    const line = render(<OnSession sector={null}>{(session) => <LifeosLine session={session} waiting={<span data-waiting />} />}</OnSession>);
    await waitFor(() => expect(times(WORDS[down])).toBe(1));
    expect(presses()).toEqual(may === "may" ? [label] : []);
    expect(times(ELSEWHERE)).toBe(may === "may" ? 0 : 1);
    line.unmount();
    const frame = render(<ViewFrame view="tasks" environmentId="env_box" workspaceId="ws" sector="purdue" />);
    await waitFor(() => expect(times(WORDS[down])).toBe(1));
    expect(presses(screen.getByRole("region")).filter((p) => p === label)).toEqual(may === "may" ? [label] : []);
    expect(times(ELSEWHERE)).toBe(may === "may" ? 0 : 1);
    frame.unmount();
    render(<TodayPageView model={{ kind: "day", blocks: [{ kind: "lifeos", reach: down }], offline: [], keys: [] }} hostName={() => "The box"} lifeosHost="The box" lifeosEnv="env_box" onRetryLifeos={vi.fn()} />);
    expect(times(WORDS[down])).toBe(1);
    expect(presses()).toEqual(may === "may" ? [label] : []);
    expect(times(ELSEWHERE)).toBe(may === "may" ? 0 : 1);
  });
});

/** Council round 7 (Opus, Today 2): Show the code and Sign in outside the frame opened Settings, where he pressed again. */
describe("a sign-in's press, outside the frame", () => {
  it.each(["signed-out", "pairing"] as const)("opens the sign-in dialog in place (%s)", async (down) => {
    host(down);
    render(<OnSession sector="purdue">{(session) => <DownLine session={session} />}</OnSession>);
    await waitFor(() => expect(document.querySelector(`[data-session-down="${down}"]`)).toBeTruthy());
    expect(screen.queryByRole("dialog")).toBeNull();
    await act(async () => screen.getByRole("button", { name: PRESS[downPress(down)!] }).click());
    // The dialog's chunk lands, and it asks the host for the code itself.
    await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy(), { timeout: 5000 });
    if (down === "signed-out") await waitFor(() => expect(asked).toContain("work.lifeos.pairStart"));
  });
});

/** Council round 7 (Sol, Mail 1): the host answered its status, then not the session's ask: that is its silence, by its name. */
describe("a session ask the host did not answer", () => {
  it("says the host did not answer, never LifeOS, with Retry, in a part's place and the settings line", async () => {
    host("jwt-unanswered");
    const part = render(<OnSession sector="purdue">{(session) => <DownLine session={session} />}</OnSession>);
    await waitFor(() => expect(document.querySelector('[data-session-down="unanswered"]')).toBeTruthy());
    expect(times("The box did not answer")).toBe(1);
    expect(document.body.textContent).not.toMatch(/LifeOS did not answer/);
    expect(presses()).toEqual(["Retry"]);
    part.unmount();
    render(<OnSession sector={null}>{(session) => <LifeosLine session={session} waiting={<span data-waiting />} />}</OnSession>);
    await waitFor(() => expect(times("The box did not answer")).toBe(1));
    expect(presses()).toEqual(["Retry"]);
  });
});

describe("the view frame's Retry, not answered again", () => {
  it("says it once: the line that names the host's silence stays, and no toast says it again", async () => {
    host("unanswered");
    render(<ViewFrame view="tasks" environmentId="env_box" workspaceId="ws" sector="purdue" />);
    await waitFor(() => expect(document.querySelector("[data-view-state=failed]")?.textContent).toContain("The box did not answer"));
    await act(async () => screen.getByRole("button", { name: "Retry" }).click());
    await settle();
    expect(asked.filter((m) => m === "work.lifeos.status").length).toBeGreaterThan(1);
    expect(toasts).toEqual([]);
    expect(times("The box did not answer")).toBe(1);
  });
});

describe("a meeting's page with the session down", () => {
  it("offers no Add people or notes, whose dialogs the page's body holds, and keeps the verbs the host runs alone", () => {
    const noop = () => {};
    const verbs = { busy: null, thread: true, brief: "brief" as const, notes: false, rest: 0, ahead: null, onBrief: noop, onFollowUp: noop, onOpenThread: noop, onNotes: noop, onAddPeople: noop, onThread: noop, onDismissRest: noop, onAhead: noop };
    const { rerender } = render(<PageVerbs {...verbs} verb="addNotes" dialogs={false} />);
    expect(screen.queryByRole("button", { name: "Add notes" })).toBeNull();
    rerender(<PageVerbs {...verbs} verb="addNotes" />);
    expect(screen.getByRole("button", { name: "Add notes" })).toBeTruthy();
  });
});

/**
 * A host whose answers change while a reader is on screen: its status, the session's ask and Waiting on's days are each
 * read from `now`, and `push` says a new status the way the host's `work.lifeos` push does.
 */
function liveHost(now: { status: () => Promise<unknown>; jwt: () => Promise<unknown>; days?: () => Promise<unknown> }) {
  asked = [];
  const pushes = new Set<(push: { push: string; status: unknown }) => void>();
  vi.spyOn(registry, "environment").mockReturnValue({ id: "env_box", name: "The box" } as never);
  vi.spyOn(registry, "statusOf").mockReturnValue({ transport: "open" } as never);
  vi.spyOn(registry, "linkOf").mockReturnValue({
    environmentId: "env_box",
    connected: true,
    onPush: (fn: (push: { push: string; status: unknown }) => void) => (pushes.add(fn), () => void pushes.delete(fn)),
    onOpen: () => () => {},
    request: vi.fn(async (method: string) => {
      asked.push(method);
      if (method === "work.lifeos.status") return now.status();
      if (method === "work.lifeos.jwt") return now.jwt();
      if (method === "work.mail.waiting") return (now.days ?? (() => new Promise(() => {})))();
      return new Promise(() => {});
    }),
  } as never);
  return {
    now,
    push: async (status: unknown) => {
      await act(async () => {
        // A push is a fresh object off the wire, never the one an earlier answer gave.
        for (const fn of [...pushes]) fn({ push: "work.lifeos", status: structuredClone(status) });
      });
      await settle();
    },
  };
}
const SIGNED_OUT = { lifeos: { state: "signed-out" }, keys: [] };
const SILENT = { lifeos: { state: "unreachable", since: 1 }, keys: [] };
const READS = { ok: true, url: "https://lifeos.test", jwt: "jwt" };

/** Council round 8 (Sol, Mail 1): LifeOS did not answer the box, then the box itself did not answer his Retry. */
describe("a Retry the host does not answer, over LifeOS's own silence", () => {
  it("says the host's silence once, in place of the old cause, with no toast, in the frame and in a part's place", async () => {
    const host = liveHost({ status: async () => SILENT, jwt: () => new Promise(() => {}) });
    render(
      <>
        <ViewFrame view="tasks" environmentId="env_box" workspaceId="ws" sector="purdue" />
        <OnSession sector="purdue">{(session) => <DownLine session={session} />}</OnSession>
      </>,
    );
    await waitFor(() => expect(times(WORDS.unreachable)).toBe(2));
    host.now.status = () => Promise.reject(timeout());
    await act(async () => screen.getAllByRole("button", { name: "Retry" })[0]!.click());
    await settle();
    expect(times(WORDS.unreachable)).toBe(0);
    expect(times(WORDS.unanswered)).toBe(2);
    expect(toasts).toEqual([]);
    // A fresh answer is the newest cause again.
    await host.push(SILENT);
    expect(times(WORDS.unanswered)).toBe(0);
    expect(times(WORDS.unreachable)).toBe(2);
  });

  it("says a second failure for another cause by that cause, once: a session ask that failed, then the host silent", async () => {
    const host = liveHost({ status: async () => connected, jwt: () => Promise.reject(new Error("socket closed")) });
    render(<OnSession sector="purdue">{(session) => <DownLine session={session} />}</OnSession>);
    await waitFor(() => expect(times(WORDS.unreachable)).toBe(1));
    host.now.status = () => Promise.reject(timeout());
    await act(async () => screen.getByRole("button", { name: "Retry" }).click());
    await settle();
    expect(times(WORDS.unreachable)).toBe(0);
    expect(times(WORDS.unanswered)).toBe(1);
    // The host answers again, connected: the session is asked for again, with no press, and reads.
    host.now.status = async () => connected;
    host.now.jwt = async () => READS;
    await host.push(connected);
    await waitFor(() => expect(document.querySelector("[data-session-down]")).toBeNull());
  });
});

/** Council round 8 (Sol, Settings 1 P1, and the walk): a line stayed after the session came back. */
describe("a session that comes back", () => {
  it("drops the line with no press, in a part's place, the settings line, the frame and Waiting on, once he signs in", async () => {
    const host = liveHost({
      status: async () => SIGNED_OUT,
      jwt: async () => ({ ok: false, state: "signed-out" }),
      days: async () => ({ days: null, error: "LifeOS did not answer: Not signed in to LifeOS", routine: true }),
    });
    const workspace = { id: "ws", name: "Purdue Esports", environmentId: "env_box", sector: "purdue", kind: "work", path: "/w" };
    render(
      <>
        <OnSession sector="purdue">{(session) => <DownLine session={session} />}</OnSession>
        <OnSession sector={null}>{(session) => <LifeosLine session={session} waiting={<span data-waiting />} />}</OnSession>
        <ViewFrame view="tasks" environmentId="env_box" workspaceId="ws" sector="purdue" />
        <WaitingRows workspace={workspace as never} />
      </>,
    );
    await waitFor(() => expect(times(WORDS["signed-out"])).toBe(4));
    const daysAsked = asked.filter((m) => m === "work.mail.waiting").length;
    // He approves the code: the host says connected, and every reader reads again.
    host.now.status = async () => connected;
    host.now.jwt = async () => READS;
    host.now.days = async () => ({ days: 3, routine: true });
    await host.push(connected);
    await waitFor(() => expect(times(WORDS["signed-out"])).toBe(0));
    expect(document.querySelector("[data-session-down]")).toBeNull();
    // Waiting on read its days again, through its own ask, and shows them.
    expect(asked.filter((m) => m === "work.mail.waiting").length).toBe(daysAsked + 1);
    expect(screen.getByRole("combobox", { name: "Count sent mail as unanswered after" })).toBeTruthy();
  });
});

/**
 * Council round 12 (Opus, Outbox 1): a held calendar reply and a held chat reply, opened in the Outbox's detail while the
 * box says its LifeOS is still connecting, say the wait once, the box named, in their reads' place, with no press and no
 * bones beside it; the act's own fields stand.
 */
describe("a held act while the host's LifeOS is still connecting", () => {
  const WAIT = "LifeOS is still connecting on the box";
  const held = (kind: string, payload: object) =>
    ({ ref: { at: "lifeos", table: "x", id: kind }, environmentId: "env_box", workspaceId: "ws", kind, sector: "purdue", summary: "", verb: "Send", account: null, state: "held", payload, createdAt: NOW, updatedAt: NOW, decidedBy: null, decidedAt: null }) as never;
  const detail = (item: never) => render(<HeldDetail item={item} workspace="Purdue Esports" host="The box" onPressed={() => {}} onReview={() => {}} />);

  it("a calendar reply: the wait once in place of the event's and the day's bones", async () => {
    host("connecting");
    detail(held("calendar.op", { id: "op1", kind: "accept", eventId: "ev1", account: "landon@purdue.edu", payload: { title: "Review", startsAt: NOW, endsAt: NOW + 3_600_000 } }));
    await waitFor(() => expect(times(WAIT)).toBe(1), { timeout: 5000 });
    expect(document.querySelector("[data-lifeos-waits]")).toBeTruthy();
    expect(document.querySelector("[data-field-bones], [data-day-bones]")).toBeNull();
    expect(presses().filter((label) => /Retry|Sign in|Show the code/.test(label))).toEqual([]);
  });

  it("a chat reply: the wait once in the quote's place, the reply's words standing", async () => {
    host("connecting");
    detail(held("chat.reply", { chatId: "c1", source: "slack", chat: "Starboard Games", text: "On it" }));
    await waitFor(() => expect(times(WAIT)).toBe(1), { timeout: 5000 });
    expect(document.querySelector("[data-answers]")).toBeNull();
    expect(screen.getByText("On it")).toBeTruthy();
    expect(presses().filter((label) => /Retry|Sign in|Show the code/.test(label))).toEqual([]);
  });
});

/**
 * Council round 12 (Sol, Tasks 1 P2): a page inside a view keeps its way back while the session is down or the host's
 * LifeOS is still connecting. Going back needs no session; the view's own controls are held.
 */
describe.each(["signed-out", "unanswered", "connecting"] as const)("a page inside a view while the session is %s", (state) => {
  // The frame has said the state: only then is the header what the state makes it.
  const said = async (): Promise<void> => {
    const words = state === "connecting" ? "LifeOS is still connecting on the box" : WORDS[state];
    await waitFor(() => expect(times(words)).toBeGreaterThan(0), { timeout: 5000 });
    await settle();
  };
  it("keeps Back to Agenda on a meeting's page, and no verb of the page", async () => {
    host(state);
    const { openWorkView } = await import("../../lib/workSwitch");
    act(() => openWorkView({ workspaceId: "ws", view: "prep", event: "ev1" }));
    render(<ViewFrame view="prep" environmentId="env_box" workspaceId="ws" sector="purdue" />);
    await said();
    await waitFor(() => expect(screen.getByRole("button", { name: "Back to Agenda" })).toBeTruthy(), { timeout: 5000 });
    expect(screen.queryByRole("button", { name: /Prepare|Follow up|More/ })).toBeNull();
  });

  it("keeps Back to People on a person's page, and it goes back", async () => {
    host(state);
    const { setPlace } = await import("../people/PeopleView");
    setPlace("ws", { person: "p1" });
    render(<ViewFrame view="people" environmentId="env_box" workspaceId="ws" sector="purdue" />);
    await said();
    const back = await screen.findByRole("button", { name: "Back to People" }, { timeout: 5000 });
    act(() => back.click());
    expect(screen.queryByRole("button", { name: "Back to People" })).toBeNull();
  });

  it("keeps Back to Projects inside a project, and it goes back", async () => {
    host(state);
    const { setPlace } = await import("../projects/place");
    setPlace("ws", { at: "project", id: "pr1", layout: "list", tab: "all" } as never);
    render(<ViewFrame view="projects" environmentId="env_box" workspaceId="ws" sector="purdue" />);
    await said();
    const back = await screen.findByRole("button", { name: "Back to Projects" }, { timeout: 5000 });
    act(() => back.click());
    expect(screen.queryByRole("button", { name: "Back to Projects" })).toBeNull();
  });
});

/** Council round 12 (Sol, Settings 1 P2): Settings readers on bones alone while the host's LifeOS connected. */
describe("a settings section while the host's LifeOS is still connecting", () => {
  const WAIT = "LifeOS is still connecting on the box";

  it("LifeosLine says the wait once, the box named, with no press, in place of the section's bones", async () => {
    host("connecting");
    render(<OnSession sector={null}>{(session) => <LifeosLine session={session} waiting={<span data-waiting />} />}</OnSession>);
    await waitFor(() => expect(times(WAIT)).toBe(1));
    expect(document.querySelector("[data-waiting]")).toBeNull();
    expect(presses()).toEqual([]);
  });

  it("Mail's settings, as Settings → Work mounts them, say the wait", async () => {
    host("connecting");
    const { Section } = await import("../mail/MailSettingsSection");
    render(<Section environmentId="env_box" />);
    await waitFor(() => expect(times(WAIT)).toBe(1));
    expect(document.querySelector('[data-slot="skeleton"]')).toBeNull();
    expect(presses()).toEqual([]);
  });
});
