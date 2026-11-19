// @vitest-environment jsdom
/**
 * The mail canvas when LifeOS does not answer, and how it draws a draft read
 * only (docs/DESIGN.md "The canvas pane", Mail): the state line says the
 * failure once, the draft last read stays, and nothing pulses forever; an
 * agent's rewrite reads as taken and new words a space apart; the Mail row's
 * unread fact.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CanvasItem } from "@shared/work";
import type { CanvasShell, StatusLine } from "../canvas/kind";

const lifeos = vi.hoisted(() => ({ state: "unreachable" as string, doc: null as unknown, proposed: null as unknown }));
vi.mock("../shell/lifeos", () => ({
  useLifeosSession: (environmentId: string, sector: unknown) => ({ environmentId, sector, client: lifeos.state === "connected" ? { url: "https://lifeos.test" } : null, state: lifeos.state }),
  watchLifeos: vi.fn(),
}));
// A connected LifeOS, as far as the canvas reads it: the draft, the rewrite waiting in it, and the mailbox as a stand-in.
vi.mock("convex/react", () => ({
  ConvexProvider: ({ children }: { children: unknown }) => children,
  useConvex: () => ({ mutation: vi.fn() }),
  useQuery: () => (lifeos.proposed ? { row: { proposed: lifeos.proposed } } : { row: {} }),
}));
vi.mock("work-kit/mail", async (original) => ({
  ...(await original<object>()),
  Mailbox: () => <div data-testid="mailbox">The mail it answers</div>,
  MailClientProvider: ({ children }: { children: unknown }) => children,
  MailKitProvider: ({ children }: { children: unknown }) => children,
  useMailClient: () => ({ useComposeDoc: () => lifeos.doc, useMailAccounts: () => [] }),
}));
vi.mock("./kit", () => ({ mailClientFor: () => ({}), tempcodeMailKit: {} }));
vi.mock("../../lib/tcserver/store", () => ({ useSessionMeta: () => ({ workspaceId: "w1" }) }));
vi.mock("../../lib/tcserver/workspaces", () => ({ useWorkspaces: () => [{ id: "w1", sector: "unify" }] }));

const { Body, Letter, keepRead, resetLastRead } = await import("./MailCanvas");
const { unreadOf } = await import("./facts");
const { View: MailAct } = await import("./MailAct");

afterEach(() => {
  cleanup();
  resetLastRead();
  lifeos.doc = null;
  lifeos.proposed = null;
});

const ITEM = { id: "m1", sessionId: "t1", kind: "mail", title: "Re: Invoice 1042" } as CanvasItem;
const SOURCE = { at: "lifeos", table: "outbox", id: "ob_1" } as const;
const WORDS = { subject: "Re: Invoice 1042", text: "Hi Marisol,\n\nInvoice 1042 is attached again.", to: [{ name: "Marisol Rivera", address: "marisol@riveradental.com" }] };

function body() {
  const lines: (StatusLine | null)[] = [];
  const shell = { statusLine: (line: StatusLine | null) => void lines.push(line), review: () => {} } as unknown as CanvasShell;
  const view = render(<Body item={ITEM} source={SOURCE} env="box" state={undefined} setState={() => {}} shell={shell} />);
  return { ...view, lines };
}

describe("the mail canvas with LifeOS unreachable", () => {
  it("says so once on the state line, and keeps the draft last read, read only", () => {
    lifeos.state = "unreachable";
    keepRead("ob_1", WORDS);
    const { container, lines } = body();
    expect(lines.at(-1)).toMatchObject({ tone: "failed", word: "LifeOS did not answer", action: { label: "Retry" } });
    expect(screen.getByText(/Invoice 1042 is attached again/)).toBeTruthy();
    expect(screen.getByText("To Marisol Rivera")).toBeTruthy();
    expect(container.querySelector("[aria-busy], [data-slot=skeleton]")).toBeNull();
    // Read only: nothing to type in.
    expect(container.querySelector("input, textarea, [contenteditable=true]")).toBeNull();
  });

  it("with no copy read, draws nothing under the line rather than loading forever", () => {
    lifeos.state = "unreachable";
    const { container } = body();
    expect(container.innerHTML).toBe("");
  });

  it("still loads while LifeOS is being reached", () => {
    lifeos.state = "connecting";
    const { container, lines } = body();
    expect(lines.at(-1)).toBeNull();
    expect(container.innerHTML).not.toBe("");
  });
});

describe("a waiting rewrite", () => {
  it("takes only the composer's place: the mail it answers stays above it", () => {
    lifeos.state = "connected";
    lifeos.doc = { status: "draft", message: { ...WORDS, text: "myself.", threadId: "mt_1" } };
    lifeos.proposed = { text: "my own address." };
    const { container } = body();
    const mailbox = screen.getByTestId("mailbox");
    const rewrite = container.querySelector("[data-mail-rewrite]")!;
    expect(rewrite.textContent).toContain("my own address.");
    // The answered mail first, the rewrite under it.
    expect(mailbox.compareDocumentPosition(rewrite) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("on a new mail, with nothing answered, is the whole body", () => {
    lifeos.state = "connected";
    lifeos.doc = { status: "draft", message: { ...WORDS, text: "myself." } };
    lifeos.proposed = { text: "my own address." };
    const { container } = body();
    expect(screen.queryByTestId("mailbox")).toBeNull();
    expect(container.querySelector("[data-mail-rewrite]")).toBeNull();
    expect(container.textContent).toContain("my own address.");
  });
});

describe("a draft read only", () => {
  it("draws taken words then new ones a space apart, and the subject only when the rewrite changes it", () => {
    const { container, rerender } = render(<Letter draft={{ ...WORDS, text: "myself." }} proposed={{ text: "my own address." }} />);
    expect(container.querySelector("h2")).toBeNull();
    const inserted = container.querySelector(".bg-\\(--add-bg\\)")!;
    expect(inserted.previousElementSibling?.className).toContain("line-through");
    expect(inserted.className).toContain("ms-1.5");
    rerender(<Letter draft={WORDS} proposed={{ subject: "Invoice 1042, again" }} />);
    expect(container.querySelector("h2")).not.toBeNull();
  });

  it("names a new mail on its way or gone, and keeps its words", () => {
    render(<Letter draft={WORDS} lead="Sent to" />);
    expect(screen.getByText("Sent to Marisol Rivera")).toBeTruthy();
    expect(screen.getByText(/Invoice 1042 is attached again/)).toBeTruthy();
  });
});

describe("the Mail row", () => {
  it("counts unread threads across the accounts, and says nothing at none", () => {
    expect(unreadOf([{ count: 2 }, { count: 1 }])).toBe("3");
    expect(unreadOf([{ count: 0 }])).toBeNull();
    expect(unreadOf([])).toBeNull();
  });
});

describe("a held mail's files", () => {
  it("are the design system's attachment, one per file", () => {
    const payload = { message: { kind: "mail", to: [{ address: "a@b.co" }], cc: [], bcc: [], subject: "Hi", text: "Words", attachments: [{ name: "Invoice-1042.pdf" }] } };
    const { container } = render(<MailAct item={{ payload } as never} env="box" />);
    const file = container.querySelector("[data-slot=attachment]")!;
    expect(file.getAttribute("data-size")).toBe("sm");
    expect(file.textContent).toBe("Invoice-1042.pdf");
  });
});
