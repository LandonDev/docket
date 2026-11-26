// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const opened: string[] = [];
vi.mock("../../../lib/native", async (original) => ({
  ...(await original<typeof import("../../../lib/native")>()),
  openUrl: (url: string) => (opened.push(url), Promise.resolve()),
  thisDesktopInLine: () => "this Mac",
}));

import { registry } from "../../../lib/connection";
import { FOLD_OPEN_EVENT, FOUND_HOLD_MS, showFound } from "../../../lib/settings/reveal";
import { ComputerName } from "./ComputerName";
import { Fold } from "./Fold";
import { hostLink, hostRequest, NOT_LINKED } from "./hostRpc";
import { LIST_FILTER_PAST, ListFilter, filterList, useListFilter } from "./ListFilter";
import { ManagedLine } from "./ManagedLine";
import { Permissions } from "./Permissions";
import { SettingRow } from "./SettingRow";

afterEach(() => {
  cleanup();
  opened.length = 0;
  vi.restoreAllMocks();
});

describe("hostRpc: one request to one computer", () => {
  const link = (id: string) => ({ environmentId: id, request: vi.fn(() => Promise.resolve(id)) });

  it("asks this window's own server for its own computer, and another computer over that computer's own link", async () => {
    const own = link("local");
    const box = link("env_box");
    vi.spyOn(registry, "primary").mockReturnValue(own as never);
    vi.spyOn(registry, "link").mockImplementation((id) => (id === "env_box" ? (box as never) : undefined));
    expect(hostLink("local")).toBe(own);
    expect(await hostRequest("env_box", "admission.set", { cap: 8 })).toBe("env_box");
    expect(box.request).toHaveBeenCalledWith("admission.set", { cap: 8 });
    expect(own.request).not.toHaveBeenCalled();
  });

  it("refuses a computer this window has no link to, and writes nothing", async () => {
    const own = link("local");
    vi.spyOn(registry, "primary").mockReturnValue(own as never);
    vi.spyOn(registry, "link").mockReturnValue(undefined);
    await expect(hostRequest("env_gone", "work.set", { enabled: false })).rejects.toThrow(NOT_LINKED);
    expect(own.request).not.toHaveBeenCalled();
  });
});

describe("ComputerName", () => {
  it("says this window's own computer by its name with this Mac after it, muted", () => {
    render(<ComputerName computer={{ name: "MacBook-Pro", own: true }} />);
    const own = screen.getByText("this Mac");
    expect(own.className).toContain("text-muted-foreground");
    expect(own.parentElement?.textContent).toBe("MacBook-Prothis Mac");
  });

  it("says any other computer by its name alone", () => {
    render(<ComputerName computer={{ name: "The box", own: false }} />);
    expect(screen.queryByText("this Mac")).toBeNull();
    expect(screen.getByText("The box")).toBeTruthy();
  });
});

describe("ManagedLine", () => {
  it("says who can, with no control", () => {
    render(<ManagedLine computer="The box" />);
    expect(screen.getByText("Changed from a computer that manages the box.")).toBeTruthy();
    expect(document.querySelector("button, input, [role=switch]")).toBeNull();
  });

  it("names the computer that manages it where the caller knows it, always as a sentence", () => {
    render(<ManagedLine computer="PURDUE-LT" by="The box" />);
    expect(screen.getByText("Changed from the box.")).toBeTruthy();
  });
});

describe("Fold", () => {
  it("is shut until pressed, with its rows mounted so search can find one", () => {
    render(
      <Fold label="Advanced">
        <SettingRow id="sharing.port" />
      </Fold>,
    );
    const trigger = screen.getByRole("button", { name: "Advanced" });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(document.querySelector('[data-setting="sharing.port"]')).not.toBeNull();
    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
  });

  it("opens when a row inside it is the one asked for, and that row holds its fill for 900 ms", async () => {
    vi.useFakeTimers();
    render(
      <Fold label="Advanced">
        <SettingRow id="sharing.port" />
      </Fold>,
    );
    const row = document.querySelector<HTMLElement>('[data-setting="sharing.port"]')!;
    row.scrollIntoView = vi.fn();
    await act(async () => void showFound(row));
    expect(screen.getByRole("button", { name: "Advanced" }).getAttribute("aria-expanded")).toBe("true");
    expect(row.hasAttribute("data-found")).toBe(true);
    await act(async () => vi.advanceTimersByTime(FOUND_HOLD_MS + 1));
    expect(row.hasAttribute("data-found")).toBe(false);
    vi.useRealTimers();
  });

  it("hears the open event only on itself", () => {
    render(
      <>
        <Fold label="Advanced">x</Fold>
        <Fold label="More">y</Fold>
      </>,
    );
    act(() => void document.querySelectorAll("[data-fold]")[1].dispatchEvent(new CustomEvent(FOLD_OPEN_EVENT)));
    expect(screen.getByRole("button", { name: "Advanced" }).getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByRole("button", { name: "More" }).getAttribute("aria-expanded")).toBe("true");
  });
});

describe("ListFilter", () => {
  const names = (n: number) => Array.from({ length: n }, (_, i) => `add-on ${i + 1}`);
  function List({ items }: { items: string[] }) {
    const filter = useListFilter(items, (item) => item);
    return (
      <>
        <ListFilter filter={filter} label="Find an add-on" />
        {filter.shown.map((item) => (
          <p key={item}>{item}</p>
        ))}
      </>
    );
  }

  it("has no field for a list of eight rows or fewer", () => {
    render(<List items={names(LIST_FILTER_PAST)} />);
    expect(screen.queryByRole("searchbox")).toBeNull();
    expect(screen.getAllByText(/add-on/)).toHaveLength(8);
  });

  it("narrows a longer list as he types, and says when nothing matches", () => {
    render(<List items={[...names(8), "linear"]} />);
    const field = screen.getByRole("searchbox", { name: "Find an add-on" });
    fireEvent.change(field, { target: { value: "LIN" } });
    expect(screen.getByText("linear")).toBeTruthy();
    expect(screen.queryByText("add-on 1")).toBeNull();
    fireEvent.change(field, { target: { value: "zzz" } });
    expect(screen.getByText("Nothing matches “zzz”")).toBeTruthy();
  });

  it("matches every typed word, in any order", () => {
    expect(filterList(["Landon's iPhone", "PURDUE-LT browser"], (s) => s, "iphone landon")).toEqual(["Landon's iPhone"]);
    expect(filterList(["a", "b"], (s) => s, "  ")).toEqual(["a", "b"]);
  });
});

describe("Permissions", () => {
  const without = { accessibility: "Threads cannot read or press anything without it", screen: "Threads cannot see a window without it" };

  it("lists both grants on Computer use: granted in words, missing with its line and Grant…", () => {
    render(<Permissions accessibility screen={false} without={without} />);
    expect(document.querySelector('[data-setting="computer.accessibility"]')?.textContent).toBe("AccessibilityGranted");
    const screenRow = document.querySelector('[data-setting="computer.screen"]')!;
    expect(screenRow.textContent).toContain(without.screen);
    fireEvent.click(screen.getByRole("button", { name: "Grant…" }));
    expect(opened).toEqual(["x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"]);
  });

  it("shows another page only a grant that is missing, marked as shown from Computer use", () => {
    const { rerender } = render(<Permissions accessibility screen={false} missingOnly without={without} />);
    expect(document.querySelector('[data-setting="computer.accessibility"]')).toBeNull();
    expect(document.querySelector('[data-setting="computer.screen"]')?.hasAttribute("data-shown")).toBe(true);
    rerender(<Permissions accessibility screen missingOnly without={without} />);
    expect(document.querySelector("[data-setting]")).toBeNull();
  });

  it("is a skeleton until the grant is known, never a made-up state", () => {
    render(<Permissions accessibility={null} screen={null} without={without} />);
    expect(screen.getAllByTestId("permission-skeleton")).toHaveLength(2);
    expect(screen.queryByText("Granted")).toBeNull();
  });
});
