// @vitest-environment jsdom
/**
 * Go to's panel says where its lookup stands (docs/DESIGN.md "The Files place"): a lookup still out after a beat
 * shows Loading…, a refused one says so with Retry, and words that match nothing show one muted No matches row.
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const host = vi.hoisted(() => ({ answer: null as null | ((text: string) => Promise<{ entries: unknown[] }>) }));
vi.mock("../../lib/connection", async (original) => ({
  ...(await original<typeof import("../../lib/connection")>()),
  registry: { linkOf: () => ({ request: (_method: string, params: { text: string }) => host.answer!(params.text) }) },
}));

const { GoToField, SLOW_MS } = await import("./GoTo");

const field = (): HTMLInputElement => screen.getByRole("combobox", { name: "Go to" }) as HTMLInputElement;
const draw = () => render(<GoToField link="box" workspaceId="w1" tabs={[]} onPick={() => undefined} onClose={() => undefined} />);
const settle = () => act(async () => void (await Promise.resolve()));

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("Go to's states", () => {
  it("shows Loading… only once a lookup is slow, then No matches for words that match nothing", async () => {
    let answer: (v: { entries: unknown[] }) => void = () => undefined;
    host.answer = () => new Promise((resolve) => (answer = resolve));
    draw();
    fireEvent.change(field(), { target: { value: "zzz" } });
    expect(screen.queryByText("Loading…")).toBeNull();
    act(() => void vi.advanceTimersByTime(SLOW_MS));
    expect(screen.getByText("Loading…")).toBeTruthy();
    await act(async () => answer({ entries: [] }));
    expect(screen.queryByText("Loading…")).toBeNull();
    expect(screen.getByText("No matches")).toBeTruthy();
  });

  it("says a refused lookup failed, and Retry asks again", async () => {
    const asked: string[] = [];
    host.answer = (text) => (asked.push(text), Promise.reject(new Error("work.files.names: no answer")));
    draw();
    fireEvent.change(field(), { target: { value: "run" } });
    await settle();
    expect(screen.getByRole("alert").textContent).toContain("Couldn't load names");
    expect(screen.queryByText("No matches")).toBeNull();
    host.answer = (text) => (asked.push(text), Promise.resolve({ entries: [] }));
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await settle();
    expect(asked.at(-1)).toBe("run");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("No matches")).toBeTruthy();
  });

  it("draws no panel for an empty field that found nothing", async () => {
    host.answer = () => Promise.resolve({ entries: [] });
    draw();
    await settle();
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(field().getAttribute("aria-expanded")).toBe("false");
  });
});
