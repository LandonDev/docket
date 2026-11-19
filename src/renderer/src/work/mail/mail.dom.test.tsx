// @vitest-environment jsdom
/**
 * The mail pillar's screens (docs/agents/work-mail.md): Send goes through
 * the host and never to LifeOS from this window; a held mail in the Outbox
 * shows exactly what goes; an agent's rewrite reads as words taken and put
 * in; Start thread names the mail.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HeldItem } from "@shared/work";
import type { OutboxActions, SaveArgs } from "work-kit/mail";

const calls: { method: string; params: Record<string, unknown> }[] = [];
vi.mock("../../lib/connection", async (original) => ({
  ...(await original<object>()),
  registry: {
    linkOf: () => ({
      request: async (method: string, params: Record<string, unknown> = {}) => {
        calls.push({ method, params });
        if (params.id === "ob_late") throw new Error("A draft a thread made goes now or not at all.");
        return { id: params.id, via: params.id === "ob_own" ? "owner" : "hold" };
      },
    }),
  },
}));

const { sendThroughHost, tempcodeMailKit } = await import("./kit");
const { View: MailAct } = await import("./MailAct");
const { mailActView, mailChip } = await import("./model");
const { proposalDiff } = await import("./proposal");

afterEach(() => {
  cleanup();
  calls.length = 0;
});

function fakeActions(id: string) {
  const log: string[] = [];
  const actions = {
    save: vi.fn(async () => {
      log.push("save");
      return id;
    }),
    send: vi.fn(async () => {
      log.push("convex send");
      return id;
    }),
    cancel: vi.fn(async () => true),
  } as unknown as OutboxActions;
  return { actions, log };
}

const args = { message: { to: [{ address: "me@example.com" }], cc: [], bcc: [{ address: "b@example.com" }], subject: "Hi", text: "Words" } } as unknown as SaveArgs;
const seen = { to: ["me@example.com"], cc: [], bcc: ["b@example.com"], subject: "Hi", text: "Words" };

describe("Send", () => {
  it("saves the draft as shown, then asks the host to send it, and never sends from the window", async () => {
    const { actions, log } = fakeActions("ob_1");
    const wrapped = sendThroughHost("box", actions);
    expect(await wrapped.send({ ...args })).toBe("ob_1");
    expect(log).toEqual(["save"]);
    expect(calls).toEqual([{ method: "work.mail.send", params: { id: "ob_1", seen } }]);
  });

  it("answers Undo on a mail the hold sent with Already sent, and leaves his own mail's Undo to LifeOS", async () => {
    const held = fakeActions("ob_9");
    const wrappedHeld = sendThroughHost("box", held.actions);
    await wrappedHeld.send({ ...args });
    expect(await wrappedHeld.cancel("ob_9")).toBe(false);
    expect(held.actions.cancel).not.toHaveBeenCalled();
    const own = fakeActions("ob_own");
    const wrappedOwn = sendThroughHost("box", own.actions);
    await wrappedOwn.send({ ...args });
    expect(await wrappedOwn.cancel("ob_own")).toBe(true);
    expect(own.actions.cancel).toHaveBeenCalledWith("ob_own");
  });

  it("carries the time he chose, and the host's refusal reaches the composer", async () => {
    const { actions } = fakeActions("ob_late");
    await expect(sendThroughHost("box", actions).send({ ...args, sendAt: 1_800_000_000_000 })).rejects.toThrow("goes now or not at all");
    expect(calls).toEqual([{ method: "work.mail.send", params: { id: "ob_late", seen, sendAt: 1_800_000_000_000 } }]);
    expect(actions.send).not.toHaveBeenCalled();
  });
});

describe("a held mail in the Outbox", () => {
  const item = (payload: unknown) => ({ payload }) as HeldItem;
  const payload = {
    id: "ob_1",
    status: "draft",
    message: {
      kind: "mail",
      from: { address: "landon@unifyplatforms.com" },
      to: [{ name: "Marisol Rivera", address: "marisol@riveradental.com" }],
      cc: [],
      bcc: [{ address: "books@unifyplatforms.com" }],
      subject: "Re: Invoice 1042",
      text: "Hi Marisol,\n\nInvoice 1042 is attached again.",
      html: "<p>Hi Marisol,</p>",
      attachments: [{ name: "Invoice-1042.pdf" }],
    },
    proposed: { text: "Could you send payment by Friday?" },
  };

  it("shows who it is from and to, its subject, its words and files as they go", () => {
    render(<MailAct item={item(payload)} env="box" />);
    const rows = [...document.querySelectorAll("dt")].map((dt) => [dt.textContent, dt.nextElementSibling?.textContent]);
    expect(rows).toEqual([
      ["From", "landon@unifyplatforms.com"],
      ["To", "Marisol Rivera marisol@riveradental.com"],
      ["Bcc", "books@unifyplatforms.com"],
      ["Subject", "Re: Invoice 1042"],
    ]);
    expect(screen.getByText(/Invoice 1042 is attached again/).textContent).toBe("Hi Marisol,\n\nInvoice 1042 is attached again.");
    expect(screen.getByText("Invoice-1042.pdf")).toBeTruthy();
    expect(screen.getByText("A rewrite waits in the draft beside its thread.")).toBeTruthy();
  });

  it("names a mail with no subject and no rewrite plainly", () => {
    const view = mailActView({ message: { kind: "mail", to: [{ address: "a@b.co" }], cc: [], bcc: [], subject: " ", text: "" } });
    expect(view).toEqual({ rows: [{ label: "To", people: [{ address: "a@b.co" }] }, { label: "Subject", text: "(no subject)" }], body: "", files: [], proposed: false });
  });
});

describe("an agent's rewrite", () => {
  it("reads as the words it takes out and puts in, and leaves an unchanged part alone", () => {
    const diff = proposalDiff({ subject: "Re: Invoice 1042", text: "If it can go out this week I'd be grateful." }, { text: "Could you send payment by Friday?" });
    expect(diff.subject).toBeNull();
    const ops = diff.body!;
    expect(ops.filter((o) => o.op !== "+").map((o) => o.text).join("")).toBe("If it can go out this week I'd be grateful.");
    expect(ops.filter((o) => o.op !== "-").map((o) => o.text).join("")).toBe("Could you send payment by Friday?");
    expect(proposalDiff({ subject: "A", text: "same" }, { subject: "B", text: " same " }).body).toBeNull();
  });
});

describe("Start thread", () => {
  it("puts the mail in the new thread's composer by its LifeOS thread", () => {
    expect(mailChip("mt_1", " Re: Invoice 1042 ")).toEqual({ kind: "mail", label: "Re: Invoice 1042", ref: { at: "lifeos", table: "mailThreads", id: "mt_1" } });
    expect(mailChip("mt_2", null).label).toBe("A mail");
  });
});

describe("the kit", () => {
  it("draws a sector by name, and no bare dot on a row: its screens hold one sector", () => {
    const { SectorMark } = tempcodeMailKit;
    const { container, rerender } = render(<SectorMark sector="life" label={false} />);
    expect(container.innerHTML).toBe("");
    rerender(<SectorMark sector="life" />);
    expect(container.textContent).toBe("Life");
  });
});
