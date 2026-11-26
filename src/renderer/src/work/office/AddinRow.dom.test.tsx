// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const NOW = Date.UTC(2026, 10, 23, 17);
import type { OfficeAddinKey } from "@shared/contract-work-office";
import type { Link } from "../../lib/connection/link";
const confirm = vi.hoisted(() => ({ answer: true, asked: [] as { title: string; body?: string }[] }));
vi.mock("../../chrome/ConfirmDialog", async (original) => ({
  ...(await original<object>()),
  confirmAction: async (request: { title: string; body?: string }) => {
    confirm.asked.push(request);
    return confirm.answer;
  },
}));
const { AddinRow, addinLine } = await import("./AddinRow");

beforeEach(() => void vi.setSystemTime(NOW));
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const KEY: OfficeAddinKey = { id: "k1", name: "Excel on the web", app: "excel", createdAt: 1, seenAt: 1, live: true };

/** A link that answers from a list the test changes, and records every call. */
function fakeLink(keys: OfficeAddinKey[]) {
  const calls: { method: string; params: unknown }[] = [];
  const link = {
    connected: true,
    onOpen: () => () => {},
    request: (method: string, params: unknown) => {
      calls.push({ method, params });
      if (method === "work.office.addin.list") return Promise.resolve({ keys: [...keys] });
      if (method === "work.office.addin.pair") return Promise.resolve({ code: "K7M2Q9XP", expiresAt: NOW + 5 * 60_000 });
      if (method === "work.office.addin.remove") {
        keys.splice(keys.findIndex((k) => k.id === (params as { id: string }).id), 1);
        return Promise.resolve({ removed: true });
      }
      return Promise.reject(new Error(`unexpected ${method}`));
    },
  } as unknown as Link;
  return { link, calls };
}

describe("addinLine", () => {
  it("says whether it is connected, else when it last was", () => {
    expect(addinLine({ live: true, seenAt: 1 })).toBe("Connected");
    expect(addinLine({ live: false, seenAt: null })).toBe("Not connected yet");
    expect(addinLine({ live: false, seenAt: NOW - 3 * 3600_000 })).toBe("Last connected 3h ago");
  });
});

describe("AddinRow", () => {
  it("says it is not paired, and Pair… shows the code with its time left", async () => {
    const { link, calls } = fakeLink([]);
    await act(async () => void render(<AddinRow link={link} title="Office add-in" />));
    expect(screen.getByText("Not paired")).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Pair…" })));
    expect(await screen.findByText("K7M2Q9XP")).toBeTruthy();
    expect(screen.getByText("5:00")).toBeTruthy();
    expect(calls.map((c) => c.method)).toEqual(["work.office.addin.list", "work.office.addin.pair"]);
  });

  it("lists each paired add-in with Remove…, which asks first and forgets it only on Remove", async () => {
    const { link, calls } = fakeLink([KEY]);
    confirm.answer = false;
    await act(async () => void render(<AddinRow link={link} title="Office add-in" />));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Remove…" })));
    expect(confirm.asked.at(-1)).toEqual({ title: "Remove Excel on the web?", body: "This add-in stops reaching Work until you pair it again.", action: "Remove", danger: true });
    expect(calls.some((c) => c.method === "work.office.addin.remove")).toBe(false);
    cleanup();
    confirm.answer = true;
    await act(async () => void render(<AddinRow link={link} title="Office add-in" />));
    expect(screen.queryByText("Not paired")).toBeNull();
    expect(screen.getByText("Excel on the web")).toBeTruthy();
    expect(screen.getByText("Connected")).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Remove…" })));
    expect(calls.find((c) => c.method === "work.office.addin.remove")?.params).toEqual({ id: "k1" });
    expect(await screen.findByText("Not paired")).toBeTruthy();
  });

  it("holds the code's 24px line with a bone while it is asked for, so nothing moves when it lands", async () => {
    let land!: (v: unknown) => void;
    const { link } = fakeLink([]);
    const base = link.request.bind(link);
    (link as { request: unknown }).request = (method: string, params: unknown) => (method === "work.office.addin.pair" ? new Promise((r) => (land = r)) : base(method, params as never));
    await act(async () => void render(<AddinRow link={link} title="Office add-in" />));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Pair…" })));
    const bone = screen.getByRole("status", { name: "Asking for a code" });
    expect(bone.className).toContain("h-6");
    expect(screen.queryByText("Asking for a code…")).toBeNull();
    await act(async () => land({ code: "K7M2Q9XP", expiresAt: NOW + 60_000 }));
    expect(screen.queryByRole("status", { name: "Asking for a code" })).toBeNull();
    expect(screen.getByText("K7M2Q9XP")).toBeTruthy();
  });

  it("says a failed list and a failed Remove in his words, never the link's text", async () => {
    const { link } = fakeLink([KEY]);
    const base = link.request.bind(link);
    (link as { request: unknown }).request = (method: string, params: unknown) =>
      method === "work.office.addin.remove" ? Promise.reject(new Error("work.office.addin.remove: EIO at /Users/landon/.tc")) : base(method, params as never);
    await act(async () => void render(<AddinRow link={link} title="Office add-in" />));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Remove…" })));
    expect(screen.getByText("The computer did not remove the add-in.")).toBeTruthy();
    expect(document.body.textContent).not.toContain("addin.remove");
  });
});
