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
const draw = (on: { onPick?: (row: unknown) => void; onClose?: () => void } = {}) =>
  render(<GoToField link="box" workspaceId="w1" tabs={[]} onPick={on.onPick ?? (() => undefined)} onClose={on.onClose ?? (() => undefined)} />);
const entry = (name: string) => ({ key: name, ref: { at: "file", host: "box", path: `/w/${name}` }, folder: null, name, kind: "document", changed: 0 });
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

  it("keeps the failure in place on Retry, its Retry spinning alone, until the answer replaces it", async () => {
    host.answer = () => Promise.reject(new Error("refused"));
    draw();
    fireEvent.change(field(), { target: { value: "run" } });
    await settle();
    let answer: (v: { entries: unknown[] }) => void = () => undefined;
    host.answer = () => new Promise((resolve) => (answer = resolve));
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    act(() => void vi.advanceTimersByTime(SLOW_MS));
    expect(screen.getByRole("alert").textContent).toContain("Couldn't load names");
    const retry = screen.getByRole("button", { name: "Retry" }) as HTMLButtonElement;
    expect(retry.disabled).toBe(true);
    expect(retry.querySelector("[data-busy]")).not.toBeNull();
    expect(screen.queryByText("Loading…")).toBeNull();
    await act(async () => answer({ entries: [] }));
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

describe("Go to by keyboard", () => {
  it("stays open while Tab takes the focus from the field to Retry, and Retry gives it back to the field", async () => {
    const onClose = vi.fn();
    host.answer = () => Promise.reject(new Error("refused"));
    draw({ onClose });
    fireEvent.change(field(), { target: { value: "run" } });
    await settle();
    const retry = screen.getByRole("button", { name: "Retry" });
    // Tab: the field's blur names Retry as where the focus goes.
    fireEvent.blur(field(), { relatedTarget: retry });
    retry.focus();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("listbox").contains(retry)).toBe(false);
    host.answer = () => Promise.resolve({ entries: [] });
    fireEvent.click(retry);
    await settle();
    expect(document.activeElement).toBe(field());
    expect(onClose).not.toHaveBeenCalled();
  });

  it("closes when the focus leaves the field and its panel, and on Escape from Retry", async () => {
    const onClose = vi.fn();
    host.answer = () => Promise.reject(new Error("refused"));
    draw({ onClose });
    fireEvent.change(field(), { target: { value: "run" } });
    await settle();
    fireEvent.keyDown(screen.getByRole("button", { name: "Retry" }), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.blur(field(), { relatedTarget: document.body });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("keeps an older lookup's names inert under new words, and drops them once the new lookup is slow", async () => {
    const onPick = vi.fn();
    const answers: Record<string, (v: { entries: unknown[] }) => void> = {};
    host.answer = (text) => new Promise((resolve) => (answers[text] = resolve));
    draw({ onPick });
    fireEvent.change(field(), { target: { value: "run" } });
    await act(async () => answers.run!({ entries: [entry("Run of show.docx")] }));
    const old = screen.getByRole("option", { name: /Run of show/ });
    expect(old.hasAttribute("aria-disabled")).toBe(false);
    fireEvent.change(field(), { target: { value: "budget" } });
    // The older words' row stays drawn but cannot be taken, by a press or by Return.
    expect(screen.getByRole("option", { name: /Run of show/ }).getAttribute("aria-disabled")).toBe("true");
    fireEvent.mouseDown(screen.getByRole("option", { name: /Run of show/ }));
    expect(onPick).not.toHaveBeenCalled();
    act(() => void vi.advanceTimersByTime(SLOW_MS));
    expect(screen.queryByRole("option", { name: /Run of show/ })).toBeNull();
    expect(screen.getByText("Loading…")).toBeTruthy();
    await act(async () => answers.budget!({ entries: [entry("Budget.xlsx")] }));
    fireEvent.mouseDown(screen.getByRole("option", { name: /Budget/ }));
    expect(onPick).toHaveBeenCalledWith({ is: "entry", entry: expect.objectContaining({ name: "Budget.xlsx" }) });
  });

  it("takes the first row once the names come for a Return pressed while they were out", async () => {
    const onPick = vi.fn();
    const answers: Record<string, (v: { entries: unknown[] }) => void> = {};
    host.answer = (text) => new Promise((resolve) => (answers[text] = resolve));
    draw({ onPick });
    fireEvent.change(field(), { target: { value: "budget" } });
    fireEvent.keyDown(field(), { key: "Enter" });
    expect(onPick).not.toHaveBeenCalled();
    await act(async () => answers.budget!({ entries: [entry("Budget.xlsx")] }));
    expect(onPick).toHaveBeenCalledWith({ is: "entry", entry: expect.objectContaining({ name: "Budget.xlsx" }) });
  });

  it("drops a waiting Return when the words change: new words' names are not taken", async () => {
    const onPick = vi.fn();
    const onClose = vi.fn();
    const answers: Record<string, (v: { entries: unknown[] }) => void> = {};
    host.answer = (text) => new Promise((resolve) => (answers[text] = resolve));
    draw({ onPick, onClose });
    fireEvent.change(field(), { target: { value: "run" } });
    fireEvent.keyDown(field(), { key: "Enter" });
    fireEvent.change(field(), { target: { value: "budget" } });
    await act(async () => answers.budget!({ entries: [entry("Budget.xlsx")] }));
    await act(async () => answers.run!({ entries: [entry("Run of show.docx")] }));
    expect(screen.getByRole("option", { name: /Budget/ })).toBeTruthy();
    expect(onPick).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("drops a waiting Return when the words become a New command: the command waits for its own Return", async () => {
    const onPick = vi.fn();
    host.answer = () => new Promise(() => undefined);
    draw({ onPick });
    fireEvent.change(field(), { target: { value: "run" } });
    fireEvent.keyDown(field(), { key: "Enter" });
    fireEvent.change(field(), { target: { value: "new sheet called Budget" } });
    await settle();
    expect(screen.getByRole("option", { name: /New sheet called Budget/ })).toBeTruthy();
    expect(onPick).not.toHaveBeenCalled();
    fireEvent.keyDown(field(), { key: "Enter" });
    expect(onPick).toHaveBeenCalledWith({ is: "new", what: "sheet", name: "Budget" });
  });
});
