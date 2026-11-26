// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@renderer/lib/sounds", () => ({ playCue: () => {} }));

import { SettingSwitch } from "../../../components/setting-switch";
import { CommitField } from "../hosts/CommitField";
import { SettingRow, SettingSection } from "./SettingRow";
import { NOT_SAVED, SAVED_HOLD_MS, SAVE_SLOW_MS, useSaved } from "./useSaved";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/** A row whose change the test settles by hand. */
function Row({ change }: { change: (on: boolean) => Promise<unknown> }) {
  const [on, setOn] = useState(false);
  const saved = useSaved();
  return (
    <SettingRow id="sub.commands" saved={saved}>
      <SettingSwitch label="May run commands itself" on={on} onChange={(next) => saved.run(() => change(next).then(() => setOn(next)))} />
    </SettingRow>
  );
}

const mark = () => document.querySelector("[data-slot=save-mark]")!;
const flip = () => fireEvent.click(screen.getByRole("switch"));
const checked = () => screen.getByRole("switch").getAttribute("aria-checked");

describe("a row's save, said one way", () => {
  it("moves the control at once and shows nothing while the answer is quick", async () => {
    let land: () => void = () => {};
    render(<Row change={() => new Promise<void>((done) => (land = done))} />);
    flip();
    expect(checked()).toBe("true");
    expect(mark().getAttribute("data-state")).toBe("saving");
    expect(mark().textContent).toBe("");
    await act(async () => land());
    expect(mark().textContent).toBe("Saved");
  });

  it("puts a spinner before the control once the answer takes over 150 ms", async () => {
    render(<Row change={() => new Promise(() => {})} />);
    flip();
    await act(async () => vi.advanceTimersByTime(SAVE_SLOW_MS - 1));
    expect(mark().querySelector("[data-slot=spinner]")).toBeNull();
    await act(async () => vi.advanceTimersByTime(2));
    expect(mark().querySelector("[data-slot=spinner]")).not.toBeNull();
    // Before the control: the control itself never moves.
    expect(mark().nextElementSibling?.getAttribute("role") ?? mark().nextElementSibling?.querySelector("[role=switch]")?.getAttribute("role")).toBe("switch");
  });

  it("holds a check and Saved for 1.4 s, then goes", async () => {
    render(<Row change={() => Promise.resolve()} />);
    flip();
    await act(async () => {});
    expect(mark().textContent).toBe("Saved");
    await act(async () => vi.advanceTimersByTime(SAVED_HOLD_MS - 1));
    expect(mark().textContent).toBe("Saved");
    await act(async () => vi.advanceTimersByTime(2));
    expect(mark().textContent).toBe("");
  });

  it("on a refusal puts the control back and says why under the row, in the house's words", async () => {
    render(<Row change={() => Promise.reject(new Error("refused: the box is offline"))} />);
    flip();
    expect(checked()).toBe("true");
    await act(async () => {});
    expect(checked()).toBe("false");
    expect(screen.getByText("The box is offline")).toBeTruthy();
    expect(mark().textContent).toBe("");
  });

  it("says it did not save when the computer gave no reason, and drops the line at the next try", async () => {
    let fail = true;
    render(<Row change={() => (fail ? Promise.reject(new Error("")) : Promise.resolve())} />);
    flip();
    await act(async () => {});
    expect(screen.getByText(NOT_SAVED)).toBeTruthy();
    fail = false;
    flip();
    expect(screen.queryByText(NOT_SAVED)).toBeNull();
    await act(async () => {});
    expect(checked()).toBe("true");
  });

  it("lets the newest change own the marks: an older answer changes nothing", async () => {
    const lands: (() => void)[] = [];
    render(<Row change={() => new Promise<void>((done) => lands.push(done))} />);
    flip();
    flip();
    await act(async () => lands[0]());
    expect(mark().textContent).toBe("");
    await act(async () => lands[1]());
    expect(mark().textContent).toBe("Saved");
  });

  it("snaps a refused field back to the value the computer holds", async () => {
    function Field() {
      const saved = useSaved();
      return (
        <SettingRow id="here.stuck" saved={saved}>
          <CommitField kind="int" aria-label="Minutes" value={10} min={1} max={1440} onCommit={() => saved.run(() => Promise.reject(new Error("refused: needs admin")))} />
        </SettingRow>
      );
    }
    render(<Field />);
    const field = screen.getByRole("textbox", { name: "Minutes" }) as HTMLInputElement;
    fireEvent.focus(field);
    fireEvent.change(field, { target: { value: "25" } });
    fireEvent.blur(field);
    await act(async () => {});
    expect(field.value).toBe("10");
    expect(screen.getByText("Needs admin")).toBeTruthy();
  });
});

describe("SettingRow and SettingSection", () => {
  it("names a row from the map and carries its id for search to find", () => {
    render(
      <SettingSection of="pc.atOnce" vars={{ computer: "the box" }}>
        <SettingRow id="pc.atOnce" />
        <SettingRow id="pc.may" vars={{ computer: "the box" }} />
      </SettingSection>,
    );
    expect(screen.getByRole("heading", { name: "Threads on the box" })).toBeTruthy();
    expect(document.querySelector('[data-setting="pc.atOnce"]')?.textContent).toBe("Threads at once");
    expect(document.querySelector('[data-setting="pc.may"]')?.textContent).toBe("What the box may do on this Mac");
  });

  it("marks a section that is a list as the map's row, and a row that only shows another page's setting", () => {
    render(
      <SettingSection of="here.apps">
        <SettingRow id="computer.screen" shown />
      </SettingSection>,
    );
    expect(document.querySelector('section[data-setting="here.apps"]')).not.toBeNull();
    expect(document.querySelector('[data-setting="computer.screen"]')?.hasAttribute("data-shown")).toBe(true);
  });

  it("refuses a row the map lacks", () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => render(<SettingRow id="nope" />)).toThrow(/No setting "nope"/);
    quiet.mockRestore();
  });
});
