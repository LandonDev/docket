import { describe, expect, it, vi } from "vitest";
import { liveSourceOf, switchTo, type LiveSetAnswer, type SwitchDeps } from "./liveSwitch";

const FROM = { name: "Plan.docx", service: "Teams", sending: false };

function deps(answers: LiveSetAnswer[], over: Partial<SwitchDeps> = {}) {
  const lines: (string | null)[] = [];
  const d = {
    set: vi.fn(async () => answers.shift() ?? { is: "done" as const }),
    flush: vi.fn(async () => true),
    leave: vi.fn(async () => true),
    typed: vi.fn(async () => 0),
    confirm: vi.fn(async () => true),
    saveWord: vi.fn(async () => true),
    busy: (line: string | null) => void lines.push(line),
    ...over,
  };
  return { d, lines };
}

describe("switching to Live", () => {
  it("flushes the kind, then switches when nothing is pending", async () => {
    const { d } = deps([{ is: "done" }]);
    expect(await switchTo("live", FROM, d)).toBe(true);
    expect(d.flush).toHaveBeenCalled();
    expect(d.set).toHaveBeenCalledWith({ mode: "live" });
    expect(d.confirm).not.toHaveBeenCalled();
  });

  it("stops when the kind could not send what it held, and asks the host nothing", async () => {
    const { d, lines } = deps([{ is: "done" }], { flush: vi.fn(async () => false) });
    await expect(switchTo("live", FROM, d)).rejects.toThrow("has not been saved yet");
    expect(d.set).not.toHaveBeenCalled();
    expect(lines.at(-1)).toBeNull();
  });

  it("says the copy's changes go first, and clears the line after", async () => {
    const { d, lines } = deps([{ is: "done" }]);
    await switchTo("live", { ...FROM, sending: true }, d);
    expect(lines).toEqual(["Sending your changes first…", null]);
  });

  it.each(["changed", "gone", "away", "refused"] as const)("asks Keep Both over a copy whose file %s, and switches on it", async (why) => {
    const { d } = deps([{ is: "ask", why, words: "This file changed on MacBook." }, { is: "done" }]);
    expect(await switchTo("live", FROM, d)).toBe(true);
    expect(d.confirm).toHaveBeenCalledWith(expect.objectContaining({ action: "Keep Both", body: "This file changed on MacBook." }));
    expect(d.set).toHaveBeenLastCalledWith({ mode: "live", choice: "keep-both" });
  });

  it("stays on Cancel, and never asks the host to drop anything", async () => {
    const { d } = deps([{ is: "ask", why: "changed", words: "x" }], { confirm: vi.fn(async () => false) });
    expect(await switchTo("live", FROM, d)).toBe(false);
    expect(d.set).toHaveBeenCalledTimes(1);
  });

  it("asks once: a second refusal after Keep Both is the host's last word", async () => {
    const { d } = deps([{ is: "ask", why: "away", words: "x" }, { is: "ask", why: "away", words: "x" }]);
    expect(await switchTo("live", FROM, d)).toBe(false);
    expect(d.confirm).toHaveBeenCalledTimes(1);
  });

  it("over Word edits not in the Word file, offers Save as Word, then switches", async () => {
    const { d } = deps([{ is: "ask", why: "word", words: "Changes since 9:12 PM are not in the Word file." }, { is: "done" }]);
    expect(await switchTo("live", FROM, d)).toBe(true);
    expect(d.confirm).toHaveBeenCalledWith(expect.objectContaining({ action: "Save to Teams as Word…" }));
    expect(d.saveWord).toHaveBeenCalled();
    expect(d.set).toHaveBeenLastCalledWith({ mode: "live" });
  });

  it("stays when the Word save does not go through", async () => {
    const { d } = deps([{ is: "ask", why: "word", words: "x" }], { saveWord: vi.fn(async () => false) });
    expect(await switchTo("live", FROM, d)).toBe(false);
    expect(d.set).toHaveBeenCalledTimes(1);
  });
});

describe("switching to Edit here", () => {
  it("reads his typing before the guest goes, then tells the host", async () => {
    const order: string[] = [];
    const { d, lines } = deps([{ is: "done" }], {
      typed: vi.fn(async () => (order.push("typed"), 4)),
      leave: vi.fn(async () => (order.push("leave"), true)),
    });
    expect(await switchTo("here", FROM, d)).toBe(true);
    expect(order).toEqual(["typed", "leave"]);
    expect(d.set).toHaveBeenCalledWith({ mode: "here", typed: 4 });
    expect(lines).toEqual(["Getting the newest from Teams…", null]);
  });

  it("says nothing of waiting when he typed nothing", async () => {
    const { d, lines } = deps([{ is: "done" }]);
    await switchTo("here", FROM, d);
    expect(lines).toEqual([null]);
  });

  it("stays live when he keeps Word open while it saves", async () => {
    const { d } = deps([], { leave: vi.fn(async () => false) });
    expect(await switchTo("here", FROM, d)).toBe(false);
    expect(d.set).not.toHaveBeenCalled();
  });
});

describe("liveSourceOf", () => {
  it("is a Microsoft file by address, of Word, Excel or PowerPoint", () => {
    const url = "https://purdue0-my.sharepoint.com/personal/x/Documents/Plan.docx?web=1";
    expect(liveSourceOf({ source: { at: "microsoft", app: "word", host: "box", name: "Plan.docx", ref: { kind: "url", url } } as never })).toEqual({ url, app: "word" });
    expect(liveSourceOf({ source: { at: "microsoft", app: "word", host: "box", name: "Plan.docx", ref: { kind: "path", path: "/x" } } as never })).toBeNull();
    expect(liveSourceOf({ source: { at: "file", host: "box", path: "/x" } })).toBeNull();
    expect(liveSourceOf(null)).toBeNull();
  });
});
