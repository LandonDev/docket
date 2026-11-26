// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const host = vi.hoisted(() => ({
  answer: null as null | ((pass: unknown) => void),
  refuse: null as null | ((error: Error) => void),
  /** Every request in order, each with its own answer and refusal. */
  calls: [] as { answer: (pass: unknown) => void; refuse: (error: Error) => void }[],
}));
vi.mock("../lib/tcserver/projects", () => {
  const link = {
    connected: true,
    onOpen: () => () => {},
    request: () =>
      new Promise((resolve, reject) => {
        host.answer = resolve;
        host.refuse = reject;
        host.calls.push({ answer: resolve, refuse: reject });
      }),
  };
  return { linkOfWorkspace: () => link };
});
vi.mock("../components/choice-select", async () => await import("../components/choice-select-body"));
vi.mock("../lib/sounds", () => ({ playCue: vi.fn() }));

const { TurnPassEditor } = await import("./TurnPassFields");

afterEach(() => {
  cleanup();
  host.calls = [];
});

describe("After each turn", () => {
  it("holds its rows in their shape until the pass loads", async () => {
    render(<TurnPassEditor workspaceId="w1" />);
    const section = screen.getByRole("region", { name: "After each turn" });
    expect(section.querySelectorAll("[data-slot=page-row-skeleton]")).toHaveLength(3);
    await act(async () => host.answer?.({ verify: true, build: false, commit: "off" }));
    expect(screen.getByRole("switch", { name: "Make a fresh build" })).toBeTruthy();
    expect(section.querySelector("[data-slot=page-row-skeleton]")).toBeNull();
  });

  it("names each row from the map, its switch named the same", async () => {
    render(<TurnPassEditor workspaceId="w1" />);
    await act(async () => host.answer?.({ verify: true, build: false, commit: "off" }));
    const section = screen.getByRole("region", { name: "After each turn" });
    const titles = [...section.querySelectorAll("[data-slot=page-row] [data-slot=item-title]")].map((el) => el.textContent);
    expect(titles).toEqual(["Run the checks", "Make a fresh build", "Commit"]);
    expect(screen.getByRole("switch", { name: "Run the checks" })).toBeTruthy();
    expect(section.textContent).not.toMatch(/Verify|Make a build/);
  });

  it("ends the skeleton when turnpass.get fails: the error and Retry, which asks again", async () => {
    render(<TurnPassEditor workspaceId="w1" />);
    await act(async () => host.refuse?.(new Error("The host did not answer")));
    const section = screen.getByRole("region", { name: "After each turn" });
    expect(section.querySelector("[data-slot=page-row-skeleton]")).toBeNull();
    expect(within(section).getByRole("alert").textContent).toBe("The host did not answer");
    await act(async () => fireEvent.click(within(section).getByRole("button", { name: "Retry" })));
    await act(async () => host.answer?.({ verify: true, build: false, commit: "off" }));
    expect(screen.getByRole("switch", { name: "Run the checks" })).toBeTruthy();
  });

  it("puts the held value back when the host refuses a save, under its red line", async () => {
    render(<TurnPassEditor workspaceId="w1" />);
    await act(async () => host.answer?.({ verify: true, build: false, commit: "off" }));
    const build = screen.getByRole("switch", { name: "Make a fresh build" });
    fireEvent.click(build);
    expect(build.getAttribute("aria-checked")).toBe("true");
    await act(async () => host.refuse?.(new Error("Refused by the host")));
    expect(screen.getByRole("switch", { name: "Make a fresh build" }).getAttribute("aria-checked")).toBe("false");
    expect(screen.getByText("Refused by the host").className).toContain("text-destructive");
  });

  it("puts back the value the host last took, never an earlier change it never took", async () => {
    render(<TurnPassEditor workspaceId="w1" />);
    await act(async () => host.answer?.({ verify: true, build: false, commit: "off" }));
    const checked = (name: string) => screen.getByRole("switch", { name }).getAttribute("aria-checked");
    // Two changes in flight: Fresh build on, then Checks off.
    fireEvent.click(screen.getByRole("switch", { name: "Make a fresh build" }));
    fireEvent.click(screen.getByRole("switch", { name: "Run the checks" }));
    const [first, second] = host.calls.slice(-2);
    // The earlier refusal puts nothing back while a newer change is on its way.
    await act(async () => first.refuse(new Error("Refused by the host")));
    expect(checked("Run the checks")).toBe("false");
    // The newer refusal puts back what the host holds: neither change.
    await act(async () => second.refuse(new Error("Refused by the host")));
    expect(checked("Make a fresh build")).toBe("false");
    expect(checked("Run the checks")).toBe("true");
  });

  it("after a save the host took, a refusal puts that save back", async () => {
    render(<TurnPassEditor workspaceId="w1" />);
    await act(async () => host.answer?.({ verify: true, build: false, commit: "off" }));
    const checked = (name: string) => screen.getByRole("switch", { name }).getAttribute("aria-checked");
    fireEvent.click(screen.getByRole("switch", { name: "Make a fresh build" }));
    await act(async () => host.calls.at(-1)!.answer(null));
    fireEvent.click(screen.getByRole("switch", { name: "Run the checks" }));
    await act(async () => host.calls.at(-1)!.refuse(new Error("Refused by the host")));
    expect(checked("Make a fresh build")).toBe("true");
    expect(checked("Run the checks")).toBe("true");
  });
});
