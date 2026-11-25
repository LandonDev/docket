import { describe, expect, it, vi } from "vitest";
import { appOfName, liveLabel, liveLine, liveSourceOf, switchTo, type LiveSetAnswer, type SwitchDeps } from "./liveSwitch";

const FROM = { name: "Plan.docx", service: "Teams", sending: false, app: "word" as const };

function deps(answers: LiveSetAnswer[], over: Partial<SwitchDeps> = {}) {
  const lines: (string | null)[] = [];
  const d = {
    set: vi.fn(async () => answers.shift() ?? { is: "done" as const }),
    flush: vi.fn(async () => true),
    leave: vi.fn(async (): Promise<boolean | "forced"> => true),
    back: vi.fn(),
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
    expect(lines).toEqual(["Sending your changes first…", "Opening in Word…", null]);
  });

  it("says so at the press, before the host answers", async () => {
    let answer!: (a: LiveSetAnswer) => void;
    const { d, lines } = deps([], { set: vi.fn(() => new Promise<LiveSetAnswer>((r) => (answer = r))) });
    const going = switchTo("live", { ...FROM, app: "excel" }, d);
    await vi.waitFor(() => expect(d.set).toHaveBeenCalled());
    expect(lines).toEqual(["Opening in Excel…"]);
    answer({ is: "done" });
    expect(await going).toBe(true);
    expect(lines.at(-1)).toBeNull();
  });

  it("names the mode in its asks", async () => {
    const { d } = deps([{ is: "ask", why: "changed", words: "x" }, { is: "done" }]);
    await switchTo("live", FROM, d);
    expect(d.confirm).toHaveBeenCalledWith(expect.objectContaining({ title: "Open Plan.docx in Word for the web?" }));
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
    // The header's own press, by name (decision 10).
    expect(d.confirm).toHaveBeenCalledWith(expect.objectContaining({ action: "Save to Teams" }));
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
    expect(lines).toEqual(["Leaving Word…", "Opening it here…", null]);
  });

  it("tells the host how long ago his last key was, read before the guest goes and counting the wait to leave", async () => {
    vi.useFakeTimers();
    try {
      const { d } = deps([{ is: "done" }], {
        typed: vi.fn(async () => 4),
        quiet: vi.fn(async () => 2_000),
        leave: vi.fn(async () => (vi.advanceTimersByTime(3_000), true)),
      });
      expect(await switchTo("here", FROM, d)).toBe(true);
      expect(d.set).toHaveBeenCalledWith({ mode: "here", typed: 4, quiet: 5_000 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("says it is leaving Word while Word lets go, then opening it here, whether or not he typed", async () => {
    const seen: (string | null)[] = [];
    const { d, lines } = deps([{ is: "done" }], { leave: vi.fn(async () => (seen.push(lines.at(-1) ?? null), true)) });
    d.set.mockImplementation(async () => (seen.push(lines.at(-1) ?? null), { is: "done" as const }));
    await switchTo("here", FROM, d);
    expect(seen).toEqual(["Leaving Word…", "Opening it here…"]);
    expect(lines.at(-1)).toBeNull();
  });

  it("after Switch Anyway, has the host prove the file moved even when no key was counted", async () => {
    const { d } = deps([{ is: "done" }], { leave: vi.fn(async () => "forced" as const) });
    expect(await switchTo("here", FROM, d)).toBe(true);
    expect(d.set).toHaveBeenCalledWith({ mode: "here", typed: 1, forced: true });
    const typed = deps([{ is: "done" }], { leave: vi.fn(async () => "forced" as const), typed: vi.fn(async () => 7) });
    await switchTo("here", FROM, typed.d);
    expect(typed.d.set).toHaveBeenCalledWith({ mode: "here", typed: 7, forced: true });
  });

  it("keeps the seat after Switch Anyway when the host cannot prove the file holds his edits", async () => {
    const { d } = deps([], { leave: vi.fn(async () => "forced" as const), set: vi.fn(async () => Promise.reject(new Error("has not come down from OneDrive yet"))) });
    await expect(switchTo("here", FROM, d)).rejects.toThrow("has not come down");
    expect(d.back).toHaveBeenCalledTimes(1);
  });

  it("brings the guest back when the host keeps the tab live, and not when it switched", async () => {
    const refused = deps([], { typed: vi.fn(async () => 2), set: vi.fn(async () => Promise.reject(new Error("What you typed in Plan.docx has not come down from OneDrive yet"))) });
    await expect(switchTo("here", FROM, refused.d)).rejects.toThrow("has not come down");
    expect(refused.d.back).toHaveBeenCalledTimes(1);
    expect(refused.lines.at(-1)).toBeNull();
    const done = deps([{ is: "done" }]);
    expect(await switchTo("here", FROM, done.d)).toBe(true);
    expect(done.d.back).not.toHaveBeenCalled();
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

describe("which Files tab is asked about Office on the web", () => {
  it("asks for the four forms by name, and for a Word file opened as the document made of it by the file it copies", async () => {
    const { offersLive } = await import("./liveSwitch");
    expect(offersLive({ name: "Plan.docx" }, false)).toBe(true);
    expect(offersLive({ name: "Budget.XLSX" }, false)).toBe(true);
    // The tab wears the document's name once the Word file has opened; the switch stays.
    expect(offersLive({ name: "Plan", copyOf: { path: "/Users/him/Teams/General/Plan.docx" } }, false)).toBe(true);
    expect(offersLive({ name: "Notes.md" }, false)).toBe(false);
    expect(offersLive({ name: "Notes", copyOf: { path: "/Users/him/Teams/General/Notes.pdf" } }, false)).toBe(false);
    expect(offersLive({ name: "Anything" }, true)).toBe(true);
  });
});

describe("one name", () => {
  it("names the live mode by its app, for the web", () => {
    expect(["word", "excel", "powerpoint"].map((a) => liveLabel(a as "word"))).toEqual(["Word for the web", "Excel for the web", "PowerPoint for the web"]);
  });

  it("knows the app from the file's name, before the host answers", () => {
    expect(["Plan.docx", "Roster.XLSX", "Macros.xlsm", "Deck.pptx", "Notes.doc", "a.txt"].map(appOfName)).toEqual(["word", "excel", "excel", "powerpoint", null, null]);
  });
});

describe("liveLine", () => {
  const S = { stage: "start" as const, site: null, failed: null };
  it("says Opening in Word until ready, Signing in to Microsoft on a sign-in site, and nothing once up or failed", () => {
    expect(liveLine(S, "word")).toBe("Opening in Word…");
    expect(liveLine({ ...S, stage: "editor" }, "powerpoint")).toBe("Opening in PowerPoint…");
    expect(liveLine({ ...S, site: "login.microsoftonline.com" }, "word")).toBe("Signing in to Microsoft…");
    expect(liveLine({ ...S, stage: "ready", site: "idp.purdue.edu" }, "word")).toBe("Signing in to Microsoft…");
    expect(liveLine({ ...S, stage: "ready" }, "word")).toBeNull();
    expect(liveLine({ ...S, site: "login.microsoftonline.com", failed: "It did not load." }, "word")).toBeNull();
  });
});
