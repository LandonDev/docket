// @vitest-environment jsdom
/**
 * The owner's page in the phone's frame (frame.ts, docs/agents/work-guests.md "The phone's frame"): with
 * `chrome=none` in its address it draws no line of its own and hands the document no format row; without it, and
 * on any guest's link, the line is as it always was. The document is a stand-in: DocPage has its own tests.
 */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

window.matchMedia ??= ((query: string) => ({ matches: false, media: query, addEventListener: () => {}, removeEventListener: () => {} })) as unknown as typeof window.matchMedia;

const pages = vi.hoisted(() => [] as Record<string, unknown>[]);
vi.mock("./DocPage", () => ({
  DocPage: (props: Record<string, unknown>) => {
    pages.push(props);
    return <div data-fake-document />;
  },
}));

const service = { gone: false };
beforeEach(() => {
  service.gone = false;
  vi.stubGlobal("fetch", async (url: string) => {
    const answer = (status: number, json: unknown) => ({ ok: status < 400, status, json: async () => json }) as Response;
    if (service.gone) return answer(403, { error: "gone" });
    const path = new URL(url).pathname;
    if (path === "/w/open/redeem") return answer(200, { kind: "doc", role: "edit", title: "Run of show", expiresAt: 0, token: "t", tokenExp: Date.now() + 600_000, me: "owner", doc: "kdocrun", renew: "r1" });
    return answer(200, { kind: "doc", role: "edit", title: "Run of show", name: "Dana Lee", owner: "Landon Hale", expiresAt: Date.UTC(2026, 11, 18), token: "t", tokenExp: Date.now() + 600_000, me: "guest:L1", doc: "kdocrun" });
  });
});
afterEach(() => {
  cleanup();
  pages.length = 0;
  sessionStorage.clear();
  vi.unstubAllGlobals();
  delete (window as { webkit?: unknown }).webkit;
});

const { GuestApp } = await import("./GuestApp");
const T = "t".repeat(43);
const opened = async () => {
  await screen.findByText("", { selector: "[data-fake-document]" }, { timeout: 8000 });
  return pages.at(-1)!;
};

describe("the owner's page in the phone's frame", () => {
  it("keeps its line, its row and an address with nothing in it, without chrome=none", async () => {
    window.history.pushState(null, "", `/w/open#t=${T}`);
    render(<GuestApp />);
    const page = await opened();
    expect(document.querySelector("header")?.textContent).toContain("Run of show");
    expect(page).toMatchObject({ bare: false, frame: null });
    expect(location.hash).toBe("");
  });

  it("draws no line with chrome=none, hands the document no row, and keeps the word in the address for a reload", async () => {
    window.history.pushState(null, "", `/w/open#t=${T}&chrome=none`);
    render(<GuestApp />);
    const page = await opened();
    expect(document.querySelector("header")).toBeNull();
    expect(page).toMatchObject({ bare: true, frame: null });
    expect(location.hash).toBe("#chrome=none");
  });

  it("hands the document the bridge where the app's web view listens", async () => {
    const posted: unknown[] = [];
    (window as { webkit?: unknown }).webkit = { messageHandlers: { tcFrame: { postMessage: (m: unknown) => posted.push(m) } } };
    window.history.pushState(null, "", `/w/open#t=${T}&chrome=none`);
    render(<GuestApp />);
    const page = await opened();
    expect(page.frame).not.toBeNull();
  });

  it("says drawn at once when it opens nothing, so the app shows the page's own words", async () => {
    const posted: { kind?: string }[] = [];
    (window as { webkit?: unknown }).webkit = { messageHandlers: { tcFrame: { postMessage: (m: { kind?: string }) => posted.push(m) } } };
    service.gone = true;
    window.history.pushState(null, "", `/w/open#t=${T}&chrome=none`);
    render(<GuestApp />);
    await waitFor(() => expect(posted).toEqual([{ kind: "drawn", v: 1, offers: { format: false, find: false, undo: false } }]));
  });
});

describe("a guest's link", () => {
  it("keeps its line whatever its address says", async () => {
    (window as { webkit?: unknown }).webkit = { messageHandlers: { tcFrame: { postMessage: () => {} } } };
    window.history.pushState(null, "", `/g/L1#k=${"k".repeat(43)}&chrome=none`);
    render(<GuestApp />);
    const page = await opened();
    expect(document.querySelector("header")?.textContent).toMatch(/Run of show.*Landon Hale/);
    expect(page).toMatchObject({ bare: false, frame: null });
  });
});
