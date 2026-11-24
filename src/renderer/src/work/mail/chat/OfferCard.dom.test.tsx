// @vitest-environment jsdom
/**
 * A mail chat's answers as mail's own things (docs/agents/work-mail.md "The chat beside the mail"): a draft he puts
 * in his reply box (his own reply kept, with Undo), a rewrite he takes or leaves (a reply that changed since says so),
 * rows he ticks and acts on in one press with Mail's own bulk act, a task or an event he adds through the sheet he
 * knows, and mails and people named in prose as chips that open them.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MailClient, ThreadSummary } from "work-kit/mail";

const convex = vi.hoisted(() => ({ proposed: null as null | { subject?: string; text: string; html: string; at: number; by: string }, settle: vi.fn(), mutations: [] as unknown[], sources: [] as unknown[] }));
vi.mock("convex/react", () => ({
  // The New event dialog watches LifeOS's own row for its toast (agenda/added.ts): no row comes in a test.
  useConvex: () => ({ watchQuery: () => ({ onUpdate: () => () => undefined, localQueryResult: () => undefined }) }),
  useQuery: (ref: unknown) => {
    const name = String((ref as Record<symbol, string>)[Symbol.for("functionName")] ?? "");
    if (name.includes("sources")) return convex.sources;
    return { row: { proposed: convex.proposed ?? undefined } };
  },
  useMutation: (ref: unknown) => {
    const name = String((ref as Record<symbol, string>)[Symbol.for("functionName")] ?? "");
    return (args: unknown) => {
      convex.mutations.push({ name, args });
      return name.includes("settleProposal") ? convex.settle(args) : Promise.resolve("id");
    };
  },
}));
const toasts = vi.hoisted(() => [] as { message: string; action?: { label: string; onClick(): void }; error?: true; description?: string }[]);
vi.mock("../../../components/ui/toaster", () => {
  const toast = Object.assign((message: string, opts?: { action?: { label: string; onClick(): void } }) => void toasts.push({ message, action: opts?.action }), {
    error: (message: string, opts?: { description?: string }) => void toasts.push({ message, error: true, ...(opts?.description ? { description: opts.description } : {}) }),
  });
  return { loadToast: async () => toast, toast };
});
const submits = vi.hoisted(() => [] as string[]);
vi.mock("../../../surfaces/threadChat", () => ({ useSessionActions: () => ({ onSubmit: (_id: string, text: string) => void submits.push(text) }) }));
const views = vi.hoisted(() => [] as unknown[]);
vi.mock("../../../lib/workSwitch", async (original) => ({ ...(await original<object>()), openWorkView: (v: unknown) => void views.push(v) }));

const { MailClientProvider } = await import("work-kit/mail");
const { OfferCard, SessionLine } = await import("./OfferCard");
const { liveDraftIds, pageOf, patch } = await import("../page");
const { lifeosLinkOf } = await import("../../../surfaces/lifeosLink");
const { LifeosChip } = await import("./LifeosChip");
const { TranscriptSessionContext } = await import("../../../surfaces/transcriptSession");
const { sessionStore } = await import("../../../lib/tcserver/store");
const { ASK_AGAIN } = await import("./RewriteCard");
const { write } = await import("../client");

const at = { sessionId: "s1", workspaceId: "w1", sector: "life" as const };
const thread = (id: string, subject: string): ThreadSummary => ({ id, subject, senders: ["Dana Lee"], lastMessageAt: Date.parse("2026-11-20T10:00:00"), messageCount: 2 }) as ThreadSummary;
const message = { kind: "mail", accountId: "a1", threadId: "t1", mode: "reply", to: [{ name: "Dana Lee", address: "dana@example.com" }], cc: [], bcc: [], subject: "Re: Lunch", html: "", text: "Friday works.\nSee you then.", snippet: "" };
const batches: { ids: string[]; act: unknown }[] = [];
/** How LifeOS answers a bulk act: the card's write goes through Mail's own `write`, as the LifeOS client's batch does. */
let batchAnswer: () => Promise<unknown> = async () => null;
/** How LifeOS answers the bulk act's Undo. */
let undoAnswer: () => Promise<unknown> = async () => null;
/** How LifeOS answers a draft's discard. */
let discardAnswer: () => Promise<string> = async () => "quoted";
let stranger: { cc: { name?: string; address: string }[]; bcc: { address: string }[] } | null = null;
const discarded: string[] = [];
const saved: unknown[] = [];
const made: { threadId: string; draft: unknown }[] = [];

const client = {
  useComposeDoc: (id: string | undefined) => (id === "d-new" ? { id: "d-new", status: "draft", message: { ...message, mode: "new", threadId: undefined, subject: "Lunch" }, version: 1, editedAt: 0, urls: {} } : id === "d1" || id === "d2" ? { id: "d1", status: "draft", message: stranger ? { ...message, ...stranger } : message, version: 1, editedAt: 0, urls: {} } : id === "gone" ? null : undefined),
  useOutboxActions: () => ({
    discard: async (id: string) => {
      discarded.push(id);
      return discardAnswer();
    },
    save: async (args: unknown) => {
      saved.push(args);
      return "d2";
    },
  }),
  useMailThread: (id: string | null) => (id === "t1" ? { thread: thread("t1", "Lunch on Friday"), messages: [{ from: { name: "Dana Lee", address: "dana@example.com" }, to: [{ address: "me@example.com" }], cc: [] }] } : id === "t2" ? { thread: thread("t2", "Gym hours"), messages: [] } : id && id !== "t-pending" ? null : undefined),
  useMailActions: () => ({
    batch: (threads: readonly ThreadSummary[], act: unknown) => {
      batches.push({ ids: threads.map((t) => t.id), act });
      void write({ run: batchAnswer, failed: "archive", message: "Archived", undo: () => undoAnswer() });
    },
    makeTask: (threadId: string, draft: unknown) => void made.push({ threadId, draft }),
  }),
} as unknown as MailClient;

const draw = (offer: Parameters<typeof OfferCard>[0]["offer"]) =>
  render(
    <MailClientProvider client={client}>
      <OfferCard offer={offer} at={at} />
    </MailClientProvider>,
  );

beforeEach(() => {
  toasts.length = 0;
  submits.length = 0;
  views.length = 0;
  batches.length = 0;
  batchAnswer = async () => null;
  undoAnswer = async () => null;
  discardAnswer = async () => "quoted";
  discarded.length = 0;
  saved.length = 0;
  made.length = 0;
  convex.proposed = null;
  convex.settle = vi.fn(async () => true);
  convex.mutations.length = 0;
  patch("w1", { threadId: null, compose: null, chat: false, chatAt: null });
});
afterEach(cleanup);

describe("a draft", () => {
  it("reads whom it answers, its words and its state, live", () => {
    draw({ draft: { draftId: "d1" } });
    expect(screen.getByText("Reply")).toBeTruthy();
    // Every recipient in full, the address it really goes to beside the name; nothing to tell when all are on the thread.
    expect(document.querySelector("[data-recipients]")!.textContent).toBe("ToDana Lee dana@example.com");
    expect(document.querySelector("[data-recipients-note]")).toBeNull();
    expect(document.querySelector("[data-draft-state]")!.textContent).toBe("Draft");
    expect(document.body.textContent).toContain("Friday works.");
  });

  it("goes in the reply box of the mail it answers, opening that mail when another is open", () => {
    patch("w1", { threadId: "t9" });
    draw({ draft: { draftId: "d1" } });
    fireEvent.click(screen.getByRole("button", { name: "Put in reply" }));
    const page = pageOf("w1");
    expect(page.threadId).toBe("t1");
    expect(page.compose).toMatchObject({ open: { kind: "row", id: "d1" }, threadId: "t1", full: false });
    expect(views).toEqual([{ workspaceId: "w1", view: "mail" }]);
    expect(document.querySelector("[data-draft-state]")!.textContent).toBe("In your reply");
  });

  it("opens a new mail in Mail's composer, and names the press and the state for that", () => {
    draw({ draft: { draftId: "d-new" } });
    expect(screen.getByText("New mail")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Put in reply" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open in Mail" }));
    expect(pageOf("w1").compose).toMatchObject({ open: { kind: "row", id: "d-new" }, full: true });
    expect(document.querySelector("[data-draft-state]")!.textContent).toBe("In the composer");
  });

  it("keeps his own open reply in Drafts, and Undo puts it back", async () => {
    patch("w1", { threadId: "t5", compose: { key: 1, open: { kind: "row", id: "his" }, threadId: "t5", full: false } as never });
    draw({ draft: { draftId: "d1" } });
    fireEvent.click(screen.getByRole("button", { name: "Put in reply" }));
    expect(pageOf("w1")).toMatchObject({ threadId: "t1", compose: { open: { kind: "row", id: "d1" } } });
    await waitFor(() => expect(toasts.map((t) => t.message)).toContain("Your reply is kept in Drafts"));
    act(() => toasts.find((t) => t.message === "Your reply is kept in Drafts")!.action!.onClick());
    // Back in the mail he was in, his reply open again.
    expect(pageOf("w1")).toMatchObject({ threadId: "t5", compose: { open: { kind: "row", id: "his" } } });
  });

  it("reopens his reply on the row his composer saved it to, when it was a fresh reply", async () => {
    patch("w1", { threadId: "t1", compose: { key: 1, open: { kind: "start" }, threadId: "t1", full: false } as never });
    liveDraftIds.set("w1", "his-saved");
    draw({ draft: { draftId: "d1" } });
    fireEvent.click(screen.getByRole("button", { name: "Put in reply" }));
    await waitFor(() => expect(toasts.map((t) => t.message)).toContain("Your reply is kept in Drafts"));
    act(() => toasts.find((t) => t.message === "Your reply is kept in Drafts")!.action!.onClick());
    expect(pageOf("w1").compose).toMatchObject({ open: { kind: "row", id: "his-saved" }, threadId: "t1" });
    liveDraftIds.delete("w1");
  });

  it("says nothing when no words of his were open", async () => {
    draw({ draft: { draftId: "d1" } });
    fireEvent.click(screen.getByRole("button", { name: "Put in reply" }));
    await new Promise((r) => setTimeout(r, 10));
    expect(toasts).toEqual([]);
  });

  it("is discarded with Undo, which saves it again", async () => {
    draw({ draft: { draftId: "d1" } });
    fireEvent.click(screen.getByRole("button", { name: "Discard draft" }));
    await waitFor(() => expect(document.querySelector("[data-draft-state]")!.textContent).toBe("Discarded"));
    await waitFor(() => expect(toasts.map((t) => t.message)).toContain("Draft discarded"));
    expect(discarded).toEqual(["d1"]);
    act(() => toasts.find((t) => t.message === "Draft discarded")!.action!.onClick());
    await waitFor(() => expect(saved).toEqual([{ message, quote: "quoted" }]));
    // The card follows the draft saved again.
    await waitFor(() => expect(document.querySelector("[data-draft-state]")!.textContent).toBe("Draft"));
  });

  it("says Discarded only once LifeOS dropped it, and holds its presses while it asks", async () => {
    let answer!: (quote: string) => void;
    discardAnswer = () => new Promise((resolve) => (answer = resolve));
    draw({ draft: { draftId: "d1" } });
    fireEvent.click(screen.getByRole("button", { name: "Discard draft" }));
    // On its way: the state is still the draft's, both presses wait, and the press can not be sent twice.
    expect(document.querySelector("[data-draft-state]")!.textContent).toBe("Draft");
    expect(screen.getByRole("button", { name: "Discard draft" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Put in reply" }).hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Discard draft" }));
    expect(discarded).toEqual(["d1"]);
    await act(async () => answer("quoted"));
    expect(document.querySelector("[data-draft-state]")!.textContent).toBe("Discarded");
    expect(screen.queryByRole("button", { name: "Discard draft" })).toBeNull();
  });

  it("stays a draft with its presses when LifeOS refused the discard", async () => {
    let refuse!: (err: Error) => void;
    discardAnswer = () => new Promise((_, reject) => (refuse = reject));
    draw({ draft: { draftId: "d1" } });
    fireEvent.click(screen.getByRole("button", { name: "Discard draft" }));
    await act(async () => refuse(new Error("draft is locked")));
    expect(document.querySelector("[data-draft-state]")!.textContent).toBe("Draft");
    expect(screen.getByRole("button", { name: "Discard draft" }).hasAttribute("disabled")).toBe(false);
    await waitFor(() => expect(toasts).toContainEqual({ message: "Couldn't discard the draft", error: true, description: "Draft is locked" }));
  });
});

describe("a draft's recipients", () => {
  it("names a cc and a bcc in full, says plainly who is not on the thread, and opens in the full composer", () => {
    stranger = { cc: [{ name: "Dana Lee", address: "dana@evil.example" }], bcc: [{ address: "copy@evil.example" }] };
    try {
      draw({ draft: { draftId: "d1" } });
      const rows = document.querySelector("[data-recipients]")!.textContent!;
      expect(rows).toContain("CcDana Lee dana@evil.example");
      expect(rows).toContain("Bcccopy@evil.example");
      // The name a sender chose is no cover: the address shows, and it is not one of the thread's.
      expect(document.querySelector("[data-recipients-note]")!.textContent).toBe("Not on this thread: dana@evil.example. Bcc: copy@evil.example.");
      fireEvent.click(screen.getByRole("button", { name: "Put in reply" }));
      // The reply box opens the draft's own row, every field row in view: nothing goes that he did not see.
      expect(pageOf("w1").compose).toMatchObject({ open: { kind: "row", id: "d1" }, full: true });
    } finally {
      stranger = null;
    }
  });
});

describe("a rewrite of his reply", () => {
  it("shows words taken out and put in; Take closes his reply, settles it and opens it again", async () => {
    convex.proposed = { text: "Friday works well.\nSee you then.", html: "", at: 1, by: "s1" };
    const open = { key: 3, open: { kind: "row", id: "d1" }, threadId: "t1", full: false };
    patch("w1", { threadId: "t1", compose: open as never });
    const closedWhileSettling: unknown[] = [];
    convex.settle = vi.fn(async () => {
      closedWhileSettling.push(pageOf("w1").compose);
      return true;
    });
    draw({ rewrite: { draftId: "d1" } });
    expect(screen.getByText("Your reply to Dana Lee")).toBeTruthy();
    expect(document.body.textContent).toContain("well.");
    fireEvent.click(screen.getByRole("button", { name: "Take" }));
    await waitFor(() => expect(screen.getByText("Taken")).toBeTruthy());
    expect(convex.settle).toHaveBeenCalledWith({ id: "d1", take: true });
    expect(closedWhileSettling).toEqual([null]);
    expect(pageOf("w1").compose).toMatchObject({ key: 4, open: { kind: "row", id: "d1" } });
  });

  it("says when his reply changed since, and Ask again asks the chat", async () => {
    convex.proposed = { text: "Other words", html: "", at: 1, by: "s1" };
    convex.settle = vi.fn(async () => {
      throw new Error("The draft changed after this rewrite was proposed. Leave it instead.");
    });
    draw({ rewrite: { draftId: "d1" } });
    fireEvent.click(screen.getByRole("button", { name: "Take" }));
    await waitFor(() => expect(screen.getByText("Your reply changed since this was written")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Ask again" }));
    expect(submits).toEqual([ASK_AGAIN]);
  });
});

describe("rows to act on", () => {
  it("start ticked, name the count in the press, and run Mail's bulk act once on the ticked ones", async () => {
    draw({ rows: { act: "archive", title: "Archive 3 notices", threadIds: ["t1", "t2", "t-elsewhere"] } });
    expect(screen.getByText("Archive 3 notices")).toBeTruthy();
    await waitFor(() => expect(screen.getByRole("button", { name: "Archive 2" })).toBeTruthy());
    // A mail this job does not hold has no tick.
    expect(screen.getAllByRole("checkbox")).toHaveLength(2);
    // It is said once under the rows, not as a row of its own.
    expect(await screen.findByText("1 other is not in this job's mail")).toBeTruthy();
    expect(document.querySelectorAll("[data-row]")).toHaveLength(2);
    fireEvent.click(screen.getByRole("checkbox", { name: "Gym hours" }));
    fireEvent.click(screen.getByRole("button", { name: "Archive 1" }));
    expect(batches).toEqual([{ ids: ["t1"], act: { kind: "archive", archived: true } }]);
    await waitFor(() => expect(document.body.textContent).toMatch(/Archived 1, \d/));
  });

  it("draw a pending row's bones and keep the press's count until every row has read its mail", async () => {
    draw({ rows: { act: "archive", title: "Archive 2 notices", threadIds: ["t1", "t-pending"] } });
    // The mail still on its way: a tick, a subject and a date in bones, never a blank row.
    const bones = document.querySelector('[data-row="t-pending"][data-row-bones]')!;
    expect(bones.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThanOrEqual(2);
    await waitFor(() => expect(screen.getAllByRole("checkbox")).toHaveLength(1));
    // The count is not known yet: the press says its verb alone and waits, never "Archive 1" of 2 or "Archive 0".
    const press = screen.getByRole("button", { name: "Archive" });
    expect(press.hasAttribute("disabled") || press.getAttribute("aria-disabled") === "true").toBe(true);
    expect(document.querySelector("ul")!.getAttribute("aria-busy")).toBe("true");
  });

  it("say the past tense only once LifeOS took the write, and give the rows back with the reason when it refused", async () => {
    let refuse!: (err: Error) => void;
    batchAnswer = () => new Promise((_, reject) => (refuse = reject));
    draw({ rows: { act: "archive", title: "Archive 2 notices", threadIds: ["t1", "t2"] } });
    fireEvent.click(await screen.findByRole("button", { name: "Archive 2" }));
    // While the write is on its way: nothing claims it happened, and the ticks hold still.
    expect(document.body.textContent).not.toMatch(/Archived/);
    expect(screen.getAllByRole("checkbox").every((box) => box.getAttribute("aria-disabled") === "true" || box.hasAttribute("data-disabled"))).toBe(true);
    await act(async () => refuse(new Error("[CONVEX M(mail:batch)] [Request ID: 6f1c] Server Error\nUncaught Error: thread gone")));
    expect(document.body.textContent).not.toMatch(/Archived/);
    expect((await screen.findByRole("alert")).textContent).toBe("LifeOS did not archive them");
    // The rows are his again: a tick changes the count, and the press can run again.
    fireEvent.click(screen.getByRole("checkbox", { name: "Gym hours" }));
    batchAnswer = async () => null;
    fireEvent.click(screen.getByRole("button", { name: "Archive 1" }));
    await waitFor(() => expect(document.body.textContent).toMatch(/Archived 1, \d/));
    expect(screen.queryByRole("alert")).toBeNull();
    // The card said the refusal; no toast says it again.
    expect(toasts.filter((t) => t.error)).toEqual([]);
  });

  it("give the rows back once the toast's Undo went through, and keep Archived while it is refused", async () => {
    draw({ rows: { act: "archive", title: "Archive 2 notices", threadIds: ["t1", "t2"] } });
    fireEvent.click(await screen.findByRole("button", { name: "Archive 2" }));
    await waitFor(() => expect(document.body.textContent).toMatch(/Archived 2, \d/));
    // An Undo LifeOS refused leaves the card's word true: the mail is still archived.
    undoAnswer = async () => Promise.reject(new Error("no"));
    await waitFor(() => expect(toasts.find((t) => t.message === "Archived")?.action).toBeTruthy());
    await act(async () => toasts.find((t) => t.message === "Archived")!.action!.onClick());
    expect(document.body.textContent).toMatch(/Archived 2, \d/);
    expect(toasts).toContainEqual({ message: "Undo did not go through", error: true });
    // A second act, whose Undo goes through: the rows are his again, unticked by nothing, the press back.
    cleanup();
    toasts.length = 0;
    undoAnswer = async () => null;
    draw({ rows: { act: "archive", title: "Archive 2 notices", threadIds: ["t1", "t2"] } });
    fireEvent.click(await screen.findByRole("button", { name: "Archive 2" }));
    await waitFor(() => expect(toasts.find((t) => t.message === "Archived")?.action).toBeTruthy());
    await act(async () => toasts.find((t) => t.message === "Archived")!.action!.onClick());
    await waitFor(() => expect(screen.getByRole("button", { name: "Archive 2" })).toBeTruthy());
    expect(document.body.textContent).not.toMatch(/Archived/);
    expect(screen.getAllByRole("checkbox").some((box) => box.getAttribute("aria-disabled") === "true" || box.hasAttribute("data-disabled"))).toBe(false);
  });

  it("say a lost answer as uncertain, never as done", async () => {
    batchAnswer = async () => Promise.reject(new Error("No answer in 4 s"));
    draw({ rows: { act: "archive", title: "Archive 1 notice", threadIds: ["t1"] } });
    fireEvent.click(await screen.findByRole("button", { name: "Archive 1" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/did not confirm the change/);
    expect(document.body.textContent).not.toMatch(/Archived/);
  });
});

describe("a Mail act no screen waits on", () => {
  it("fails in one toast that names the act, with the reason under it when it is plain", async () => {
    await write({ run: async () => Promise.reject(new Error("thread is gone")), failed: "mark it read" });
    await write({ run: async () => Promise.reject(new Error("[CONVEX M(mail:archive)] Server Error")), failed: "archive" });
    await waitFor(() => expect(toasts).toHaveLength(2));
    expect(toasts).toEqual([
      { message: "Did not mark it read", error: true, description: "Thread is gone" },
      { message: "Did not archive", error: true },
    ]);
  });
});

describe("a task or an event", () => {
  it("opens New task filled in, and files it through Mail's Make task when it names a mail", async () => {
    draw({ task: { title: "Book the room", due: "2026-12-01", threadId: "t1" } });
    expect(screen.getByText("Due", { exact: false })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Add…" }));
    const title = await screen.findByDisplayValue("Book the room");
    expect(title).toBeTruthy();
    expect(screen.getByDisplayValue("2026-12-01")).toBeTruthy();
    fireEvent.submit(title.closest("form")!);
    await waitFor(() => expect(made).toHaveLength(1));
    expect(made[0]).toMatchObject({ threadId: "t1", draft: { title: "Book the room", sector: "life" } });
    await waitFor(() => expect(screen.getByText("Added")).toBeTruthy());
  });

  it("opens New event filled in with its title, day, times and place", async () => {
    draw({ event: { title: "Lunch with Dana", start: "2026-12-04T12:30:00", end: "2026-12-04T13:30:00", where: "Harry's" } });
    fireEvent.click(screen.getByRole("button", { name: "Add…" }));
    expect(await screen.findByDisplayValue("Lunch with Dana")).toBeTruthy();
    expect(screen.getByDisplayValue("2026-12-04")).toBeTruthy();
    expect(screen.getByDisplayValue("12:30")).toBeTruthy();
    expect(screen.getByDisplayValue("13:30")).toBeTruthy();
    expect(screen.getByDisplayValue("Harry's")).toBeTruthy();
  });
});

describe("mails and people named in an answer", () => {
  it("are chips for mail and people links, and any other LifeOS table stays a link", () => {
    expect(lifeosLinkOf("#lifeos:mailThreads:t1")).toEqual({ table: "mailThreads", id: "t1" });
    expect(lifeosLinkOf("#lifeos:people:p1")).toEqual({ table: "people", id: "p1" });
    expect(lifeosLinkOf("#lifeos:tasks:k1")).toBeNull();
    expect(lifeosLinkOf("https://example.com")).toBeNull();
  });

  it("open the mail through the sent chip's opener, in the thread's workspace", async () => {
    sessionStore.adopt({ id: "s1", environmentId: "box", status: "idle", archived: false, workspaceId: "w1", projectId: null, scope: "work", createdAt: 0, updatedAt: 0 } as never, { created: true });
    render(
      <TranscriptSessionContext.Provider value="s1">
        <p>
          Dana asked in <LifeosChip link={{ table: "mailThreads", id: "t1" }}>Lunch on Friday</LifeosChip>.
        </p>
      </TranscriptSessionContext.Provider>,
    );
    const chip = screen.getByRole("button", { name: "Lunch on Friday" });
    expect(chip.getAttribute("data-lifeos-chip")).toBe("mailThreads");
    fireEvent.click(chip);
    await waitFor(() => expect(views).toContainEqual({ workspaceId: "w1", view: "mail", mail: "t1" }));
  });
});

describe("a card whose LifeOS session failed", () => {
  it("says why with the press that mends it, as the mail canvas does", () => {
    const pressOf = (session: Parameters<typeof SessionLine>[0]["session"]): string[] => {
      const { container, unmount } = render(<SessionLine session={session} env="local" sector="life" />);
      const said = [container.querySelector("span")!.textContent!, ...[...container.querySelectorAll("button")].map((b) => b.textContent!)];
      unmount();
      return said;
    };
    expect(pressOf({ state: "signed-out" })).toEqual(["Not signed in to LifeOS", "Sign in"]);
    expect(pressOf({ state: "refused" })).toEqual(["LifeOS refused this host's sign-in", "Sign in"]);
    expect(pressOf({ state: "unreachable" })).toEqual(["LifeOS did not answer", "Retry"]);
    expect(pressOf({ state: "off" })).toEqual(["Work is off on this host", "Open Settings"]);
    // A computer kept from LifeOS has nothing to press that would mend it.
    expect(pressOf({ state: "unreachable", withheld: true })).toEqual(["This computer cannot read LifeOS through this host"]);
    // Council round 4 (Sol P1): a host whose status went unanswered is down, named by the registry, with Retry.
    expect(pressOf({ state: "unreachable", unanswered: true })).toEqual(["The host did not answer", "Retry"]);
  });

  it("names the computer that did not answer, as the registry names it", async () => {
    const { registry } = await import("../../../lib/connection");
    const named = vi.spyOn(registry, "environment").mockReturnValue({ name: "The box" } as never);
    const { container, unmount } = render(<SessionLine session={{ state: "unreachable", unanswered: true }} env="local" sector="life" />);
    expect(container.textContent).toBe("The box did not answerRetry");
    unmount();
    named.mockRestore();
  });
});
