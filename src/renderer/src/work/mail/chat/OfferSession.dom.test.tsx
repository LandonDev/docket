// @vitest-environment jsdom
/**
 * Council round 10 (Sol Mail 1, P1): a Mail chat card's Add… form, mounted as the product mounts it: the view frame
 * (WorkViewPage's `ViewFrame`), Mail's own view with its client guard, the chat docked beside the mail, the card in
 * the dock's transcript over the window's real LifeOS session. A sign-out or LifeOS's silence takes the Mail body and
 * the dock away; the form he has open is Mail's frame's (`Kept`), so it stays with what he typed, says the line and
 * holds Add, and files through the new session once it is back. And (Sol Mail 3, P2) a thread's cards on one down
 * session say its line and its press once, however many cards it stops.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MailClient } from "work-kit/mail";

vi.mock("../../../lib/tcserver/workspaces", async (original) => ({
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
vi.mock("../../../stores/project", async (original) => ({ ...(await original<object>()), useSelectedWorkspaceIds: () => ["ws"] }));
vi.mock("../../../components/ui/toaster", () => {
  const toast = Object.assign(() => undefined, { error: () => undefined, loading: () => undefined, message: () => undefined, success: () => undefined });
  return { loadToast: async () => toast, toast };
});
// Mail's client over LifeOS, as work-kit's fixture mail answers it; Make task is heard here.
const mail = vi.hoisted(() => ({ client: null as unknown, made: [] as { threadId: string; draft: unknown }[], card: 0 }));
vi.mock("../client", async (original) => ({ ...(await original<object>()), mailClientFor: () => mail.client }));
// The dock's transcript, as it draws a mail chat's card: the real card (MailOfferRow) in the thread's transcript.
vi.mock("./MailDock", async () => {
  const { MailOfferRow } = await import("./OfferCard");
  const { TranscriptSessionContext } = await import("../../../surfaces/transcriptSession");
  const detail = JSON.stringify({ mailOffer: { task: { title: "Book the room", due: "2026-12-01", threadId: "t1" } } });
  return {
    MailDock: () => (
      <section data-dock-stand-in>
        <TranscriptSessionContext.Provider value="s1">
          {/* A card of its own in each test: what a card's Add came to is kept by the card. */}
          <MailOfferRow block={{ id: `b${mail.card}`, role: "tool", tool: { status: "completed", detail } } as never} />
        </TranscriptSessionContext.Provider>
      </section>
    ),
  };
});

const { createFixtureMailClient } = await import("work-kit/mail/fixtures");
const { registry } = await import("../../../lib/connection");
const { sessionStore } = await import("../../../lib/tcserver/store");
const { resetLifeos, setLifeosStatus } = await import("../../shell/lifeos");
const { ViewFrame } = await import("../../shell/WorkViewPage");
const { patch } = await import("../page");
const { MailOfferRow } = await import("./OfferCard");
const { TranscriptSessionContext } = await import("../../../surfaces/transcriptSession");

const fixture = createFixtureMailClient({ write: async ({ run }) => run(), instant: true });
mail.client = {
  ...fixture,
  useMailActions() {
    const actions = fixture.useMailActions();
    return { ...actions, makeTask: (threadId: string, draft: unknown) => void mail.made.push({ threadId, draft }) };
  },
} as MailClient;

const connected = { lifeos: { state: "connected" as const, ownerId: "landon", since: 1 }, keys: [] };

beforeEach(() => {
  mail.made.length = 0;
  mail.card += 1;
  vi.spyOn(registry, "environment").mockReturnValue({ id: "env_box", name: "The box" } as never);
  vi.spyOn(registry, "statusOf").mockReturnValue({ transport: "open" } as never);
  vi.spyOn(registry, "linkOf").mockReturnValue({
    environmentId: "env_box",
    connected: true,
    onPush: () => () => {},
    onOpen: () => () => {},
    request: vi.fn(async (method: string) => {
      if (method === "work.lifeos.status") return connected;
      if (method === "work.lifeos.jwt") return { ok: true, jwt: "jwt-1", expiresAt: Date.now() + 3_600_000, url: "https://lifeos.test" };
      return new Promise(() => {});
    }),
  } as never);
  sessionStore.adopt({ id: "s1", environmentId: "env_box", status: "idle", archived: false, workspaceId: "ws", projectId: null, scope: "work", createdAt: 0, updatedAt: 0 } as never, { created: true });
  // The chat is docked beside the mail.
  patch("ws", { box: "inbox", threadId: null, compose: null, chat: true, chatAt: null });
});
afterEach(() => {
  cleanup();
  resetLifeos();
  vi.restoreAllMocks();
  patch("ws", { chat: false, chatAt: null });
});

/** Opens Mail with Ask docked, presses the card's Add… and changes the title. */
async function openForm(): Promise<HTMLInputElement> {
  setLifeosStatus("env_box", connected);
  render(<ViewFrame view="mail" environmentId="env_box" workspaceId="ws" sector="purdue" />);
  fireEvent.click(await screen.findByRole("button", { name: "Add…" }, { timeout: 10_000 }));
  const title = (await screen.findByDisplayValue("Book the room")) as HTMLInputElement;
  fireEvent.change(title, { target: { value: "Book the big room" } });
  return title;
}

const addOf = (): HTMLButtonElement => [...screen.getByRole("dialog").querySelectorAll("button")].find((b) => b.textContent === "Add")!;

describe("a Mail chat card's Add form, through the Mail view", () => {
  it("stays through a sign-out that takes the mail and the dock away, holds Add, then files through the session once it is back", async () => {
    await openForm();
    act(() => setLifeosStatus("env_box", { lifeos: { state: "signed-out" }, keys: [] } as never));
    // The frame's sign-in stands in the body's place: no mail, no dock, no card.
    await waitFor(() => expect(document.querySelector("[data-dock-stand-in]")).toBeNull());
    expect(screen.queryByRole("button", { name: "Add…" })).toBeNull();
    // The form is the frame's: his words, the session's line, Add held.
    expect(screen.getByDisplayValue("Book the big room")).toBeTruthy();
    expect(screen.getByRole("dialog").querySelector("[data-session-down]")!.textContent).toContain("Not signed in to LifeOS on the box");
    expect(addOf().disabled).toBe(true);
    act(() => setLifeosStatus("env_box", connected));
    await waitFor(() => expect(addOf().disabled).toBe(false), { timeout: 10_000 });
    expect(screen.getByRole("dialog").querySelector("[data-session-down]")).toBeNull();
    fireEvent.submit(screen.getByDisplayValue("Book the big room").closest("form")!);
    await waitFor(() => expect(mail.made).toHaveLength(1));
    expect(mail.made[0]).toMatchObject({ threadId: "t1", draft: { title: "Book the big room", sector: "purdue" } });
    // The card, back in the dock, says what his Add came to.
    await waitFor(() => expect(screen.getByText("Added")).toBeTruthy(), { timeout: 10_000 });
  });

  it("stays through LifeOS's silence, which empties Mail's client guard and the dock", async () => {
    await openForm();
    act(() => setLifeosStatus("env_box", { lifeos: { state: "unreachable", since: 1 }, keys: [] } as never));
    await waitFor(() => expect(document.querySelector("[data-dock-stand-in]")).toBeNull());
    expect(document.querySelector("[data-view-state=failed]")!.textContent).toContain("LifeOS did not answer the box");
    expect(screen.getByDisplayValue("Book the big room")).toBeTruthy();
    expect(screen.getByRole("dialog").querySelector("[data-session-down]")).toBeTruthy();
    expect(addOf().disabled).toBe(true);
  });

  it("goes when he closes it, and the card offers Add… again", async () => {
    await openForm();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByRole("button", { name: "Add…" })).toBeTruthy();
  });
});

const connecting = { lifeos: { state: "connecting" as const }, keys: [] };
/** Every press inside the view's region but outside a dialog it holds. */
const framePresses = (): string[] => [...screen.getByRole("region").querySelectorAll("button")].filter((b) => !b.closest("[role=dialog]")).map((b) => b.textContent ?? "");

describe("a host that says its LifeOS is connecting", () => {
  // Council round 11 (Sol Mail 1, P2): the known wait is one named line with no press, never bones alone.
  it("Mail's frame names the wait in the body's place, with no press and no bones, the view's name over it", async () => {
    setLifeosStatus("env_box", connecting);
    render(<ViewFrame view="mail" environmentId="env_box" workspaceId="ws" sector="purdue" />);
    const wait = await screen.findByText("LifeOS is still connecting on the box");
    expect(wait.closest("[data-lifeos-waits]")).toBeTruthy();
    expect(document.body.textContent!.split("LifeOS is still connecting on the box").length - 1).toBe(1);
    expect(document.querySelector("[aria-label='Loading Mail']")).toBeNull();
    expect(document.querySelector("[data-view-heading]")!.textContent).toBe("Mail");
    expect(framePresses()).toEqual([]);
    // Back: Mail draws, with its own head again.
    act(() => setLifeosStatus("env_box", connected));
    await waitFor(() => expect(document.querySelector("[data-dock-stand-in]")).toBeTruthy(), { timeout: 10_000 });
    expect(document.querySelector("[data-lifeos-waits]")).toBeNull();
  });

  it("the same frame names it for every view that reads LifeOS (Tasks), with none of its header's presses", async () => {
    setLifeosStatus("env_box", connecting);
    render(<ViewFrame view="tasks" environmentId="env_box" workspaceId="ws" sector="purdue" />);
    await screen.findByText("LifeOS is still connecting on the box");
    await waitFor(() => expect(document.querySelector("[data-view-heading]")).toBeTruthy());
    expect(framePresses()).toEqual([]);
  });

  it("keeps the dock's open form with his words and Add held, while the frame names the wait; back, it files", async () => {
    await openForm();
    act(() => setLifeosStatus("env_box", connecting));
    await waitFor(() => expect(document.querySelector("[data-dock-stand-in]")).toBeNull());
    expect(screen.getByRole("region").querySelector("[data-lifeos-waits]")).toBeTruthy();
    expect(screen.getByDisplayValue("Book the big room")).toBeTruthy();
    expect(addOf().disabled).toBe(true);
    act(() => setLifeosStatus("env_box", connected));
    await waitFor(() => expect(addOf().disabled).toBe(false), { timeout: 10_000 });
    expect(document.querySelector("[data-lifeos-waits]")).toBeNull();
  });
});

describe("a thread's cards on one down session", () => {
  const card = (id: string, offer: object) => <MailOfferRow key={id} block={{ id, role: "tool", tool: { status: "completed", detail: JSON.stringify({ mailOffer: offer }) } } as never} />;
  const Thread = ({ ids }: { ids: string[] }) => (
    <TranscriptSessionContext.Provider value="s1">
      {ids.map((id) => card(id, id === "c-task" ? { task: { title: "Book the room" } } : { event: { title: "Lunch with Dana", start: "2026-12-04T12:30:00" } }))}
    </TranscriptSessionContext.Provider>
  );

  it("say the line and its press once, the first card holding it, the next taking it when the first goes; back, each card draws again", async () => {
    setLifeosStatus("env_box", { lifeos: { state: "signed-out" }, keys: [] } as never);
    const view = render(<Thread ids={["c-task", "c-event"]} />);
    await waitFor(() => expect(document.querySelectorAll("[data-offer-session]")).toHaveLength(1), { timeout: 10_000 });
    expect(document.body.textContent!.split("Not signed in to LifeOS on the box").length - 1).toBe(1);
    expect(screen.getAllByRole("button", { name: "Sign in" })).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Add…" })).toBeNull();
    // The first card scrolled away: the one left says it.
    view.rerender(<Thread ids={["c-event"]} />);
    expect(document.querySelectorAll("[data-offer-session]")).toHaveLength(1);
    act(() => setLifeosStatus("env_box", connected));
    view.rerender(<Thread ids={["c-task", "c-event"]} />);
    await waitFor(() => expect(screen.getAllByRole("button", { name: "Add…" })).toHaveLength(2), { timeout: 10_000 });
    expect(document.querySelector("[data-offer-session]")).toBeNull();
  });

  it("say a host's connecting once, the first card holding the wait with no press and no bones; back, each card draws", async () => {
    // Council round 11 (Sol Mail 1, P2).
    setLifeosStatus("env_box", connecting);
    const view = render(<Thread ids={["c-task", "c-event"]} />);
    await waitFor(() => expect(document.querySelectorAll("[data-offer-session]")).toHaveLength(1), { timeout: 10_000 });
    expect(document.querySelector("[data-offer-session]")!.hasAttribute("data-lifeos-waits")).toBe(true);
    expect(document.body.textContent!.split("LifeOS is still connecting on the box").length - 1).toBe(1);
    expect(document.querySelectorAll("div[aria-label=Loading]")).toHaveLength(0);
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    // The wait turns down: the same first card says the new state with its press.
    act(() => setLifeosStatus("env_box", { lifeos: { state: "signed-out" }, keys: [] } as never));
    await waitFor(() => expect(screen.getAllByRole("button", { name: "Sign in" })).toHaveLength(1));
    expect(document.querySelector("[data-lifeos-waits]")).toBeNull();
    act(() => setLifeosStatus("env_box", connected));
    view.rerender(<Thread ids={["c-task", "c-event"]} />);
    await waitFor(() => expect(screen.getAllByRole("button", { name: "Add…" })).toHaveLength(2), { timeout: 10_000 });
  });

  it("keep their bones while the host's status is not heard yet: no wait is named before it is known", async () => {
    vi.spyOn(registry, "linkOf").mockReturnValue({ environmentId: "env_box", connected: true, onPush: () => () => {}, onOpen: () => () => {}, request: () => new Promise(() => {}) } as never);
    render(<Thread ids={["c-task", "c-event"]} />);
    await waitFor(() => expect(document.querySelectorAll("div[aria-label=Loading]")).toHaveLength(2));
    expect(document.querySelector("[data-lifeos-waits]")).toBeNull();
  });
});
