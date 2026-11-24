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
const toasts = vi.hoisted(() => [] as { message: string; action?: { label: string; onClick(): void } }[]);
vi.mock("../../../components/ui/toaster", () => {
  const toast = Object.assign((message: string, opts?: { action?: { label: string; onClick(): void } }) => void toasts.push({ message, action: opts?.action }), { error: (message: string) => void toasts.push({ message }) });
  return { loadToast: async () => toast, toast };
});
const submits = vi.hoisted(() => [] as string[]);
vi.mock("../../../surfaces/threadChat", () => ({ useSessionActions: () => ({ onSubmit: (_id: string, text: string) => void submits.push(text) }) }));
const views = vi.hoisted(() => [] as unknown[]);
vi.mock("../../../lib/workSwitch", async (original) => ({ ...(await original<object>()), openWorkView: (v: unknown) => void views.push(v) }));

const { MailClientProvider } = await import("work-kit/mail");
const { OfferCard } = await import("./OfferCard");
const { liveDraftIds, pageOf, patch } = await import("../page");
const { lifeosLinkOf } = await import("../../../surfaces/lifeosLink");
const { LifeosChip } = await import("./LifeosChip");
const { TranscriptSessionContext } = await import("../../../surfaces/transcriptSession");
const { sessionStore } = await import("../../../lib/tcserver/store");
const { ASK_AGAIN } = await import("./RewriteCard");

const at = { sessionId: "s1", workspaceId: "w1", sector: "life" as const };
const thread = (id: string, subject: string): ThreadSummary => ({ id, subject, senders: ["Dana Lee"], lastMessageAt: Date.parse("2026-11-20T10:00:00"), messageCount: 2 }) as ThreadSummary;
const message = { kind: "mail", accountId: "a1", threadId: "t1", mode: "reply", to: [{ name: "Dana Lee", address: "dana@example.com" }], cc: [], bcc: [], subject: "Re: Lunch", html: "", text: "Friday works.\nSee you then.", snippet: "" };
const batches: { ids: string[]; act: unknown }[] = [];
const discarded: string[] = [];
const saved: unknown[] = [];
const made: { threadId: string; draft: unknown }[] = [];

const client = {
  useComposeDoc: (id: string | undefined) => (id === "d1" || id === "d2" ? { id: "d1", status: "draft", message, version: 1, editedAt: 0, urls: {} } : id === "gone" ? null : undefined),
  useOutboxActions: () => ({
    discard: async (id: string) => {
      discarded.push(id);
      return "quoted";
    },
    save: async (args: unknown) => {
      saved.push(args);
      return "d2";
    },
  }),
  useMailThread: (id: string | null) => (id === "t1" ? { thread: thread("t1", "Lunch on Friday"), messages: [] } : id === "t2" ? { thread: thread("t2", "Gym hours"), messages: [] } : id ? null : undefined),
  useMailActions: () => ({
    batch: (threads: readonly ThreadSummary[], act: unknown) => void batches.push({ ids: threads.map((t) => t.id), act }),
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
    expect(screen.getByText("Reply to Dana Lee")).toBeTruthy();
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
    expect(document.querySelector("[data-draft-state]")!.textContent).toBe("Discarded");
    await waitFor(() => expect(toasts.map((t) => t.message)).toContain("Draft discarded"));
    expect(discarded).toEqual(["d1"]);
    act(() => toasts.find((t) => t.message === "Draft discarded")!.action!.onClick());
    await waitFor(() => expect(saved).toEqual([{ message, quote: "quoted" }]));
    // The card follows the draft saved again.
    await waitFor(() => expect(document.querySelector("[data-draft-state]")!.textContent).toBe("Draft"));
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
    expect(screen.getByText("Not in this job's mail")).toBeTruthy();
    fireEvent.click(screen.getByRole("checkbox", { name: "Gym hours" }));
    fireEvent.click(screen.getByRole("button", { name: "Archive 1" }));
    expect(batches).toEqual([{ ids: ["t1"], act: { kind: "archive", archived: true } }]);
    expect(document.body.textContent).toMatch(/Archived 1, \d/);
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
