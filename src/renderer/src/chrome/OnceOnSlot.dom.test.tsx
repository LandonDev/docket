// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { OnceOnSlot } from "./OnceOnSlot";

afterEach(cleanup);

const slot = (on: boolean) => (
  <OnceOnSlot on={on} kept={<p>clash</p>}>
    <p>rail</p>
  </OnceOnSlot>
);

describe("OnceOnSlot", () => {
  it("mounts nothing while Work has never been on", () => {
    const { container } = render(slot(false));
    expect(container.textContent).toBe("");
  });

  it("holds Work's rail while Work is on, and keeps the clash host once Work goes off", () => {
    const { rerender } = render(slot(true));
    expect(screen.getByText("rail")).toBeTruthy();
    expect(screen.queryByText("clash")).toBeNull();
    rerender(slot(false));
    expect(screen.queryByText("rail")).toBeNull();
    expect(screen.getByText("clash")).toBeTruthy();
    rerender(slot(true));
    expect(screen.getByText("rail")).toBeTruthy();
  });
});
