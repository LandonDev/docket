// @vitest-environment jsdom
/** A project's description that could not open: his Retry keeps the reason in place, its Retry spinning, until the document answers. */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const w = vi.hoisted(() => ({ byAttempt: new Map<number, unknown>(), heard: new Set<() => void>() }));
const say = (attempt: number, value: unknown): void => {
  w.byAttempt.set(attempt, value);
  for (const fn of w.heard) fn();
};
vi.mock("../docs/DocumentCanvas", async () => {
  const React = await import("react");
  return {
    useDocument: () => ({ adapters: {} }),
    useOpened: (_env: string, _source: unknown, attempt: number) =>
      React.useSyncExternalStore(
        (fn: () => void) => (w.heard.add(fn), () => void w.heard.delete(fn)),
        () => w.byAttempt.get(attempt) ?? null,
      ),
  };
});
vi.mock("work-kit/editor", () => ({
  DOCUMENT_LADDER: {},
  DocumentEditor: ({ documentName }: { documentName: string }) => <div data-editor={documentName} />,
  EditorAdaptersProvider: ({ children }: { children: unknown }) => children,
  EditorKitProvider: ({ children }: { children: unknown }) => children,
}));

const { Description } = await import("./Description");

afterEach(() => {
  cleanup();
  w.byAttempt.clear();
});

describe("a project's description", () => {
  it("keeps the reason with Retry spinning, never the bones, until the document answers", () => {
    say(0, { error: "The Work service did not answer." });
    render(<Description env="box" docId="d1" readOnly={false} lead="" />);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(screen.getByText("The Work service did not answer.")).toBeTruthy();
    const retry = screen.getByRole("button", { name: "Retry" }) as HTMLButtonElement;
    expect(retry.disabled).toBe(true);
    expect(retry.querySelector("[data-busy]")).not.toBeNull();
    expect(document.querySelector("[data-region][data-bones]")).toBeNull();
    act(() => say(1, { host: {}, open: { doc: "d1", title: "Plan", role: "edit" } }));
    expect(document.querySelector("[data-editor=d1]")).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("is bones from a sample while it opens with no lead, and the editor lands over them", async () => {
    render(<Description env="box" docId="d2" readOnly={false} lead="" />);
    expect(document.querySelector("[data-region][data-bones]")).not.toBeNull();
    expect(document.querySelector("[skullet-loading]")?.textContent).toContain("bracket finals");
    act(() => say(0, { host: {}, open: { doc: "d2", title: "Plan", role: "edit" } }));
    expect(document.querySelector("[data-editor=d2]")).not.toBeNull();
    await waitFor(() => expect(document.querySelector("[skullet-loading]")).toBeNull());
    expect(document.querySelector("[data-region][data-bones]")).toBeNull();
  });

  it("holds its lead in the text's place while it opens, with no bones", () => {
    render(<Description env="box" docId="d3" readOnly={false} lead="The brief so far." />);
    expect(screen.getByText("The brief so far.").getAttribute("aria-busy")).toBe("true");
    expect(document.querySelector("[data-region][data-bones]")).toBeNull();
  });
});
