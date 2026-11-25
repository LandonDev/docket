// @vitest-environment jsdom
/**
 * Council round 9 (Sol, Settings 3): Waiting on's days, read while LifeOS was signed in, stayed a live control with
 * their last value after the host signed out with the page open, so the next change failed. The row takes its down
 * state from the host's live status too: down at once, the switch kept, and read again once the host is back.
 */
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registry } from "../../lib/connection";
import { resetLifeos } from "../shell/lifeos";

vi.mock("../../components/ui/toaster", () => {
  const toast = Object.assign(() => undefined, { error: () => undefined });
  return { loadToast: async () => toast, toast };
});

const { WaitingSection } = await import("./WaitingSection");

const CONNECTED = { lifeos: { state: "connected", ownerId: "landon", since: 1 }, keys: [] };
const SIGNED_OUT = { lifeos: { state: "signed-out" }, keys: [] };
const UNREACHABLE = { lifeos: { state: "unreachable", since: 1 }, keys: [] };
const CONNECTING = { lifeos: { state: "connecting" }, keys: [] };
const WORKSPACE = { id: "ws", name: "Purdue Esports", environmentId: "env_box", sector: "purdue", kind: "work", path: "/w" } as never;

let asked: string[] = [];
let days = 3;
let status: unknown = CONNECTED;
let readError: string | null = null;
/** Set: the days' read waits until it is called. */
let hold: ((go: () => void) => void) | null = null;
const pushes = new Set<(push: { push: string; status: unknown }) => void>();

function host(): void {
  asked = [];
  vi.spyOn(registry, "environment").mockReturnValue({ id: "env_box", name: "The box" } as never);
  vi.spyOn(registry, "statusOf").mockReturnValue({ transport: "open" } as never);
  vi.spyOn(registry, "linkOf").mockReturnValue({
    environmentId: "env_box",
    connected: true,
    onPush: (fn: (push: { push: string; status: unknown }) => void) => (pushes.add(fn), () => void pushes.delete(fn)),
    onOpen: () => () => {},
    request: vi.fn(async (method: string) => {
      asked.push(method);
      if (method === "work.lifeos.status") return status;
      if (method === "work.mail.waiting") {
        if (hold) await new Promise<void>((go) => hold!(go));
        return readError ? { days: null, error: readError, routine: true } : { days, routine: true };
      }
      return new Promise(() => {});
    }),
  } as never);
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 4; i++) await act(async () => void (await new Promise((r) => setTimeout(r, 0))));
};
/** A new status, as the host's `work.lifeos` push says it. */
const push = async (status: unknown): Promise<void> => {
  await act(async () => {
    for (const fn of [...pushes]) fn({ push: "work.lifeos", status: structuredClone(status) });
  });
  await settle();
};
const daysControl = () => screen.queryByRole("combobox", { name: "Count as waiting after" });
const reads = () => asked.filter((m) => m === "work.mail.waiting").length;

afterEach(() => {
  cleanup();
  resetLifeos();
  vi.restoreAllMocks();
  pushes.clear();
  days = 3;
  status = CONNECTED;
  readError = null;
  hold = null;
});

describe("Waiting on, the host's LifeOS dropping while the page is open", () => {
  it("takes the days' row down at once on a sign-out, keeps the switch, and reads again when the host is back", async () => {
    host();
    render(<WaitingSection workspace={WORKSPACE} />);
    await settle();
    expect(daysControl()).toBeTruthy();
    expect(reads()).toBe(1);
    await push(SIGNED_OUT);
    expect(daysControl()).toBeNull();
    expect(screen.getByText("Not signed in to LifeOS on the box")).toBeTruthy();
    // The nudge routine is the host's own: its switch stays usable.
    expect((screen.getByRole("switch", { name: "Draft nudges by themselves" }) as HTMLButtonElement).disabled).toBe(false);
    // On the way back, the row says so and offers nothing; once connected, the days are read again.
    await push(CONNECTING);
    expect(screen.getByText("LifeOS is still connecting on the box")).toBeTruthy();
    expect(daysControl()).toBeNull();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    days = 5;
    await push(CONNECTED);
    expect(reads()).toBe(2);
    expect(daysControl()?.textContent).toContain("5 working days");
    expect(screen.queryByText("Not signed in to LifeOS on the box")).toBeNull();
  });

  /** Council round 10 (Sol Settings 2): during connecting the row still drew Retry from an older read's sign-out. */
  it("says the one connecting line with no Retry over an older read's sign-out, Show the code while the sign-in waits, and reads again on connected", async () => {
    status = SIGNED_OUT;
    readError = "Not signed in to LifeOS";
    host();
    render(<WaitingSection workspace={WORKSPACE} />);
    await settle();
    expect(screen.getByText("Not signed in to LifeOS on the box")).toBeTruthy();
    await push({ lifeos: { state: "pairing", expiresAt: Date.now() + 600_000 }, keys: [] });
    expect(screen.getByText("The LifeOS sign-in on the box waits for your approval")).toBeTruthy();
    await push(CONNECTING);
    expect(screen.getByText("LifeOS is still connecting on the box")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(screen.getByRole("switch", { name: "Draft nudges by themselves" })).toBeTruthy();
    readError = null;
    days = 5;
    await push(CONNECTED);
    expect(reads()).toBe(2);
    expect(daysControl()?.textContent).toContain("5 working days");
  });

  /** Council round 11 (Opus Files 2, the walk): under connected heard since a saved sign-out, the row said the sign-out until the read landed. */
  it("draws the row's bone while it reads again after the host is back, never the old sign-out", async () => {
    status = SIGNED_OUT;
    readError = "Not signed in to LifeOS";
    host();
    render(<WaitingSection workspace={WORKSPACE} />);
    await settle();
    expect(screen.getByText("Not signed in to LifeOS on the box")).toBeTruthy();
    let go: () => void = () => {};
    hold = (release) => (go = release);
    readError = null;
    days = 5;
    await push(CONNECTED);
    expect(reads()).toBe(2);
    expect(screen.queryByText("Not signed in to LifeOS on the box")).toBeNull();
    expect(document.querySelector("[data-days-again]")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    await act(async () => go());
    await settle();
    expect(document.querySelector("[data-days-again]")).toBeNull();
    expect(daysControl()?.textContent).toContain("5 working days");
  });

  it("says LifeOS's silence in red with Retry in the control's place, and reads again when it answers", async () => {
    host();
    render(<WaitingSection workspace={WORKSPACE} />);
    await settle();
    await push(UNREACHABLE);
    expect(daysControl()).toBeNull();
    expect(screen.getByText("LifeOS did not answer the box")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    await push(CONNECTED);
    expect(reads()).toBe(2);
    expect(daysControl()).toBeTruthy();
  });
});
