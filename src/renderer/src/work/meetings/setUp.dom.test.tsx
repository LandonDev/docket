// @vitest-environment jsdom
/** A recording its computer cannot transcribe: one fact in his words, and Open Settings only where this window may set it up. */
import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const may = vi.hoisted(() => ({ value: true, asked: [] as unknown[] }));
vi.mock("../../lib/linkMay", async (original) => ({
  ...(await original<object>()),
  useLinkMay: (...args: unknown[]) => (may.asked.push(args), may.value),
}));
const opened = vi.hoisted(() => ({ connections: 0 }));
vi.mock("../shell/open", async (original) => ({ ...(await original<object>()), openConnections: () => void opened.connections++ }));

const { useTranscriberSetUp } = await import("./setUp");
const { Failed } = await import("./MeetingView");
const { NotesForm } = await import("../prep/PrepDialogs");

const SENTENCE = "ffmpeg, sherpa-onnx and parakeet-tdt-v2 are not installed on this host; run scripts/work-tools/install.ts.";

afterEach(() => {
  cleanup();
  may.value = true;
  may.asked = [];
  opened.connections = 0;
});

describe("useTranscriberSetUp", () => {
  it("offers Connections for the transcriber's own reason, where this window manages that computer", () => {
    const { result, rerender } = renderHook(({ error }: { error: unknown }) => useTranscriberSetUp("box", error), { initialProps: { error: SENTENCE as unknown } });
    expect(may.asked.at(-1)).toEqual(["box", "work.set", { enabled: true }]);
    result.current!();
    expect(opened.connections).toBe(1);
    // Another reason, or none, has no such press.
    rerender({ error: "It stopped at 9 of 42 minutes when the computer restarted." });
    expect(result.current).toBeNull();
    rerender({ error: null });
    expect(result.current).toBeNull();
  });

  it("offers nothing where this window may not change that computer", () => {
    may.value = false;
    const { result } = renderHook(() => useTranscriberSetUp("box", SENTENCE));
    expect(result.current).toBeNull();
  });
});

describe("the meeting canvas's failure", () => {
  it("says the host's sentence as one fact, the computer named, with Open Settings before Retry", async () => {
    const setUp = vi.fn();
    render(<Failed meeting={{ from: "recording", error: SENTENCE } as never} host="the box" onSetUp={setUp} onRetry={async () => {}} />);
    const alert = document.querySelector<HTMLElement>("[data-meeting-failed]")!;
    expect(alert.textContent).toContain("The transcriber is not set up on the box.");
    expect(alert.textContent).not.toMatch(/sherpa|parakeet|scripts/);
    const presses = [...alert.querySelectorAll("button")].map((b) => b.textContent);
    expect(presses).toEqual(["Open Settings", "Retry"]);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Open Settings" })));
    expect(setUp).toHaveBeenCalledOnce();
  });

  it("keeps Retry alone with no press handed", () => {
    render(<Failed meeting={{ from: "recording", error: SENTENCE } as never} onRetry={async () => {}} />);
    expect(screen.getByText("The transcriber is not set up on that computer.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Open Settings" })).toBeNull();
  });
});

describe("the Notes dialog's failure", () => {
  const form = (onSetUp?: () => void) => (
    <NotesForm text="" setText={() => {}} pending={null} upload={null} error="The transcriber is not set up on the box." onCancel={() => {}} onClose={() => {}} onFollowUp={() => {}} onFile={() => {}} onDocument={() => {}} {...(onSetUp ? { onSetUp } : {})} />
  );

  it("draws Open Settings under its line where it is handed one", () => {
    const setUp = vi.fn();
    render(form(setUp));
    expect(screen.getByText("The transcriber is not set up on the box.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open Settings" }));
    expect(setUp).toHaveBeenCalledOnce();
  });

  it("draws the line alone without one", () => {
    render(form());
    expect(screen.queryByRole("button", { name: "Open Settings" })).toBeNull();
  });
});
