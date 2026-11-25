// @vitest-environment jsdom
/**
 * Council round 11 (Sol Outbox 1, P2): a held LifeOS mail whose whole read met a host that says its LifeOS is
 * connecting. The note under it (MailUnread's, drawn by the Outbox's own `ItemNotes`) names the wait once, with its
 * computer and no press, beside the quote's bone; never a bone with no reason.
 */
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registry } from "../../lib/connection";
import { resetLifeos, setLifeosStatus } from "../shell/lifeos";

const { HeldDetail, ItemNotes } = await import("./HeldDetail");

const ITEM = { environmentId: "env_box", kind: "mail.send", state: "held", ref: { at: "lifeos", table: "outbox", id: "o1" } } as never;
const connecting = { lifeos: { state: "connecting" }, keys: [] } as never;

beforeEach(() => void vi.spyOn(registry, "environment").mockReturnValue({ id: "env_box", name: "The box" } as never));
afterEach(() => {
  cleanup();
  resetLifeos();
  vi.restoreAllMocks();
});

const note = (): HTMLElement | null => document.querySelector<HTMLElement>("[data-mail-unread]");

describe("a held mail's read note while its host's LifeOS is connecting", () => {
  it("names the wait with the computer, muted, with no press", () => {
    setLifeosStatus("env_box", connecting);
    render(<ItemNotes item={ITEM} host="The box" unread unreadError={new Error("LifeOS is still connecting")} onRetry={() => {}} />);
    expect(note()!.getAttribute("data-mail-unread")).toBe("connecting");
    expect(note()!.textContent).toBe("LifeOS is still connecting on the box");
    expect(note()!.querySelectorAll("button")).toHaveLength(0);
    // A wait, not a fault: no alert.
    expect(note()!.closest("[data-outbox-note]")!.getAttribute("role")).toBeNull();
  });

  it("names it from the read's own cause before the host's status is heard", () => {
    render(<ItemNotes item={ITEM} host="The box" unread unreadError={new Error("LifeOS is still connecting")} onRetry={() => {}} />);
    expect(note()!.textContent).toBe("LifeOS is still connecting on the box");
  });

  it("names it over an older cause once the host says it is connecting", () => {
    setLifeosStatus("env_box", connecting);
    render(<ItemNotes item={ITEM} host="The box" unread unreadError={new Error("This host is not signed in to LifeOS")} onRetry={() => {}} />);
    expect(note()!.getAttribute("data-mail-unread")).toBe("connecting");
    expect(note()!.querySelectorAll("button")).toHaveLength(0);
  });
});

/**
 * Council round 12 (Sol Outbox 1, P2): Retry on a held mail's unread note, through the Outbox's own detail. It asks the
 * box's LifeOS status first, then the mail, and spins in place with the note as it was until the answer replaces it;
 * the quote's bone is for a read the detail asks by itself, never for his press.
 */
describe("a held mail's Retry", () => {
  const timeout = () => Object.assign(new Error("No answer in 15 s"), { name: "TimeoutError" });
  const MAIL = { ...(ITEM as object), workspaceId: "ws", sector: "purdue", summary: "Reply to Dana", verb: "Send", account: null, payload: { to: ["dana@x.com"], subject: "Kickoff", body: "Yes" }, createdAt: 1, updatedAt: 1, decidedBy: null, decidedAt: null } as never;
  let asked: string[] = [];
  let answerGet: ((v: unknown) => void) | null = null;
  beforeEach(() => {
    asked = [];
    let gets = 0;
    vi.spyOn(registry, "linkOf").mockReturnValue({
      environmentId: "env_box",
      connected: true,
      onPush: () => () => {},
      onOpen: () => () => {},
      request: vi.fn(async (method: string) => {
        asked.push(method);
        if (method === "work.lifeos.status") return { lifeos: { state: "connected", ownerId: "landon", since: 1 }, keys: [] };
        if (method === "work.outbox.get") {
          // The first read goes unanswered; his Retry's read waits until the test answers it.
          if (gets++ === 0) throw timeout();
          return new Promise((resolve) => (answerGet = resolve));
        }
        return new Promise(() => {});
      }),
    } as never);
  });

  it("asks the status, then the mail, spinning in place with the note kept until the mail answers", async () => {
    // The rail watches the host already, as in the app.
    setLifeosStatus("env_box", { lifeos: { state: "connected", ownerId: "landon", since: 1 }, keys: [] } as never);
    render(<HeldDetail item={MAIL} workspace="Purdue Esports" host="The box" onPressed={() => {}} onReview={() => {}} />);
    await waitFor(() => expect(note()?.textContent).toContain("The box did not answer"));
    asked = [];
    await act(async () => void fireEvent.click(note()!.querySelector("button")!));
    expect(asked).toEqual(["work.lifeos.status", "work.outbox.get"]);
    // The note stays, its Retry spinning and held; no quote bone in its place.
    expect(note()!.textContent).toContain("The box did not answer");
    expect(note()!.querySelector("[data-slot=busy-label][data-busy]")).toBeTruthy();
    expect(note()!.querySelector("button")!.hasAttribute("disabled")).toBe(true);
    expect(document.querySelector("[data-mail-quote-bone]")).toBeNull();
    // The mail answers: the note goes.
    await act(async () => answerGet!({ ...(MAIL as object) }));
    await waitFor(() => expect(note()).toBeNull());
  });
});
