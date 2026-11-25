// @vitest-environment jsdom
import { act, cleanup, render, renderHook, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OfficeLiveOf } from "@shared/contract-work-office";
import { LIVE_OF_RETRY_MS, LiveControl, liveRows, useLiveOf } from "./LiveControl";

const OF: OfficeLiveOf = { mode: "here", address: "https://purdue0-my.sharepoint.com/personal/x/Documents/Plan.docx?web=1", app: "word", tenant: "purdue0", desktops: [] };
const labels = (rows: ReturnType<typeof liveRows>) => rows.map((r) => (r.kind === "item" ? `${r.label}${r.checked ? " ✓" : ""}${r.disabled ? " (off)" : ""}` : r.kind));

describe("LiveControl", () => {
  afterEach(cleanup);
  it("names the mode the tab is in", () => {
    const { rerender } = render(<LiveControl of={OF} live={false} busy={false} desktops={[]} onSwitch={() => undefined} onNoAddress={() => undefined} />);
    expect(screen.getByRole("button", { name: "Edit here" })).toBeTruthy();
    rerender(<LiveControl of={{ ...OF, app: "excel" }} live busy={false} desktops={[]} onSwitch={() => undefined} onNoAddress={() => undefined} />);
    expect(screen.getByRole("button", { name: "Excel for the web" })).toBeTruthy();
  });

  it("reads Here or Live under 480px of header, the whole name from 480px", () => {
    render(<LiveControl of={OF} live busy={false} desktops={[]} onSwitch={() => undefined} onNoAddress={() => undefined} />);
    const [short, whole] = [...screen.getByRole("button").querySelectorAll("span")];
    expect([short!.textContent, short!.className]).toEqual(["Live", "@[480px]/file-head:hidden"]);
    expect([whole!.textContent, whole!.className]).toEqual(["Word for the web", "hidden @[480px]/file-head:inline"]);
  });

  it("keeps its place, unseen and out of reach, until the host answers for a file whose app its name says", () => {
    const { container, rerender } = render(<LiveControl of={null} app="word" live={false} busy={false} desktops={[]} onSwitch={() => undefined} onNoAddress={() => undefined} />);
    const kept = container.querySelector("[data-office-live-keep]") as HTMLButtonElement;
    expect(kept.className).toContain("invisible");
    expect([kept.disabled, kept.getAttribute("aria-hidden"), kept.tabIndex, kept.textContent]).toEqual([true, "true", -1, "HereEdit here"]);
    rerender(<LiveControl of={OF} app="word" live={false} busy={false} desktops={[]} onSwitch={() => undefined} onNoAddress={() => undefined} />);
    expect(container.querySelector("[data-office-live-keep]")).toBeNull();
    expect(screen.getByRole("button", { name: "Edit here" })).toBeTruthy();
  });

  it("is not there for a file that cannot open live, nor before the host answers", () => {
    const { container, rerender } = render(<LiveControl of={{ ...OF, app: null }} live={false} busy={false} desktops={[]} onSwitch={() => undefined} onNoAddress={() => undefined} />);
    expect(container.innerHTML).toBe("");
    rerender(<LiveControl of={null} live={false} busy={false} desktops={[]} onSwitch={() => undefined} onNoAddress={() => undefined} />);
    expect(container.innerHTML).toBe("");
  });

  it("waits while a switch is under way", () => {
    render(<LiveControl of={OF} live={false} busy desktops={[]} onSwitch={() => undefined} onNoAddress={() => undefined} />);
    expect(screen.getByRole("button")).toHaveProperty("disabled", true);
  });
});

describe("liveRows", () => {
  it("ticks the mode, then lists the desktops by host", () => {
    expect(labels(liveRows(OF, false, [{ name: "MacBook" }, { name: "the Windows VM" }], true))).toEqual(["Edit here ✓", "Word for the web", "sep", "Open in Word on MacBook", "Open in Word in the Windows VM"]);
    expect(labels(liveRows({ ...OF, app: "powerpoint" }, true, [], true))).toEqual(["Edit here", "PowerPoint for the web ✓"]);
  });

  it("asks for an address first where the library has none", () => {
    expect(labels(liveRows({ ...OF, address: null }, false, [], true))).toEqual(["Edit here ✓", "Word for the web…"]);
  });

  it("in a browser, opens the web address in a tab of its own", () => {
    expect(labels(liveRows(OF, false, [], false))).toEqual(["Edit here ✓", "Open in Word for the web"]);
    expect(labels(liveRows({ ...OF, address: null }, false, [], false))).toEqual(["Edit here ✓", "Open in Word for the web (off)"]);
  });
});

describe("useLiveOf", () => {
  afterEach(() => vi.useRealTimers());

  it("asks again after a miss, keeping what it had, until the host answers", async () => {
    vi.useFakeTimers();
    const ask = vi.fn<() => Promise<OfficeLiveOf>>().mockRejectedValueOnce(new Error("lost")).mockRejectedValueOnce(new Error("lost")).mockResolvedValue(OF);
    const { result } = renderHook(() => useLiveOf(ask, "item-1"));
    await act(async () => undefined);
    expect(result.current).toBeNull();
    expect(ask).toHaveBeenCalledTimes(1);
    await act(async () => void vi.advanceTimersByTime(LIVE_OF_RETRY_MS[0]));
    expect(ask).toHaveBeenCalledTimes(2);
    await act(async () => void vi.advanceTimersByTime(LIVE_OF_RETRY_MS[1]));
    expect(ask).toHaveBeenCalledTimes(3);
    expect(result.current).toEqual(OF);
    await act(async () => void vi.advanceTimersByTime(60_000));
    expect(ask).toHaveBeenCalledTimes(3);
  });

  it("asks again at once when the link opens after a miss", async () => {
    vi.useFakeTimers();
    let opened: (() => void) | null = null;
    const onOpen = vi.fn((fn: () => void) => ((opened = fn), () => void (opened = null)));
    const ask = vi.fn<() => Promise<OfficeLiveOf>>().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(OF);
    const { result } = renderHook(() => useLiveOf(ask, "item-1", onOpen));
    await act(async () => undefined);
    expect(opened).not.toBeNull();
    await act(async () => opened!());
    expect(ask).toHaveBeenCalledTimes(2);
    expect(result.current).toEqual(OF);
    // The timer the miss set is off with it: no third ask.
    await act(async () => void vi.advanceTimersByTime(60_000));
    expect(ask).toHaveBeenCalledTimes(2);
  });
});
