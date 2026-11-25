// @vitest-environment jsdom
/**
 * Council round 11 (Sol Outbox 1, P2): a held LifeOS mail whose whole read met a host that says its LifeOS is
 * connecting. The note under it (MailUnread's, drawn by the Outbox's own `ItemNotes`) names the wait once, with its
 * computer and no press, beside the quote's bone; never a bone with no reason.
 */
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registry } from "../../lib/connection";
import { resetLifeos, setLifeosStatus } from "../shell/lifeos";

const { ItemNotes } = await import("./HeldDetail");

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
