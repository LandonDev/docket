// @vitest-environment jsdom
/**
 * The owner's page inside the phone's web view: a pass that ended (its renew refused as gone, as after a restart of
 * the host) is said to the phone, which opens the file again on a new ticket; in a browser nothing is said.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PHONE_HANDLER, tellPhone } from "./phone";

window.matchMedia ??= ((query: string) => ({ matches: false, media: query, addEventListener: () => {}, removeEventListener: () => {} })) as unknown as typeof window.matchMedia;

const asked: string[] = [];
beforeEach(() => {
  asked.length = 0;
  // A page whose ticket was redeemed before: it holds the renewal key, and the service no longer knows it.
  window.history.pushState(null, "", "/w/open");
  sessionStorage.setItem("tc-open-renew", "r".repeat(43));
  vi.stubGlobal("fetch", async (url: string) => {
    asked.push(new URL(url).pathname);
    return { ok: false, status: 403, json: async () => ({ error: "This page ran out. Open it again from TempCode." }) } as Response;
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  delete (window as { webkit?: unknown }).webkit;
  sessionStorage.clear();
});

const { GuestApp } = await import("./GuestApp");

describe("the owner's page in the phone", () => {
  it("posts passEnded when its renew is refused as gone, and still shows its own words", async () => {
    const postMessage = vi.fn();
    (window as { webkit?: unknown }).webkit = { messageHandlers: { [PHONE_HANDLER]: { postMessage } } };
    render(<GuestApp />);
    expect(await screen.findByText("This page has already been opened, or it ran out")).toBeTruthy();
    expect(asked).toEqual(["/w/open/renew"]);
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(postMessage).toHaveBeenCalledWith({ kind: "passEnded" });
    // The key that was refused is let go.
    expect(sessionStorage.getItem("tc-open-renew")).toBeNull();
  });

  it("in a browser, with no phone around it, says nothing and ends as before", async () => {
    render(<GuestApp />);
    expect(await screen.findByText("This page has already been opened, or it ran out")).toBeTruthy();
    expect(tellPhone({ kind: "passEnded" })).toBe(false);
  });

  it("a handler that throws does not break the page", () => {
    const w = { webkit: { messageHandlers: { [PHONE_HANDLER]: { postMessage: () => { throw new Error("gone"); } } } } };
    expect(tellPhone({ kind: "opened" }, w)).toBe(false);
    const heard: unknown[] = [];
    expect(tellPhone({ kind: "opened" }, { webkit: { messageHandlers: { [PHONE_HANDLER]: { postMessage: (n) => heard.push(n) } } } })).toBe(true);
    expect(heard).toEqual([{ kind: "opened" }]);
  });
});
