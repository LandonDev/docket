// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { OfficeLiveOf } from "@shared/contract-work-office";
import { LiveControl, liveRows } from "./LiveControl";

const OF: OfficeLiveOf = { mode: "here", address: "https://purdue0-my.sharepoint.com/personal/x/Documents/Plan.docx?web=1", app: "word", tenant: "purdue0", desktops: [] };
const labels = (rows: ReturnType<typeof liveRows>) => rows.map((r) => (r.kind === "item" ? `${r.label}${r.checked ? " ✓" : ""}${r.disabled ? " (off)" : ""}` : r.kind));

describe("LiveControl", () => {
  afterEach(cleanup);
  it("names the mode the tab is in", () => {
    const { rerender } = render(<LiveControl of={OF} live={false} busy={false} desktops={[]} onSwitch={() => undefined} onNoAddress={() => undefined} />);
    expect(screen.getByRole("button").textContent).toBe("Edit here");
    rerender(<LiveControl of={{ ...OF, app: "excel" }} live busy={false} desktops={[]} onSwitch={() => undefined} onNoAddress={() => undefined} />);
    expect(screen.getByRole("button").textContent).toBe("Live in Excel");
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
    expect(labels(liveRows(OF, false, [{ name: "MacBook" }, { name: "the Windows VM" }], true))).toEqual(["Edit here ✓", "Live in Word", "sep", "Open in Word on MacBook", "Open in Word in the Windows VM"]);
    expect(labels(liveRows({ ...OF, app: "powerpoint" }, true, [], true))).toEqual(["Edit here", "Live in PowerPoint ✓"]);
  });

  it("asks for an address first where the library has none", () => {
    expect(labels(liveRows({ ...OF, address: null }, false, [], true))).toEqual(["Edit here ✓", "Live in Word…"]);
  });

  it("in a browser, opens the web address in a tab of its own", () => {
    expect(labels(liveRows(OF, false, [], false))).toEqual(["Edit here ✓", "Open in Word on the Web"]);
    expect(labels(liveRows({ ...OF, address: null }, false, [], false))).toEqual(["Edit here ✓", "Open in Word on the Web (off)"]);
  });
});
