// @vitest-environment jsdom
/** A Work view that throws is its own error with Retry, which mounts it again; never the window's. */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ViewBoundary } from "./WorkViewPage";

afterEach(cleanup);

describe("a view's boundary", () => {
  it("shows what failed with Retry, and Retry mounts the view again", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    let fail = true;
    function Tasks() {
      if (fail) throw new Error("LifeOS refused the read");
      return <p>The tasks</p>;
    }
    render(
      <ViewBoundary label="Tasks">
        <Tasks />
      </ViewBoundary>,
    );
    expect(screen.getByText("Tasks did not load")).toBeTruthy();
    expect(screen.getByText("LifeOS refused the read")).toBeTruthy();
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(screen.getByText("The tasks")).toBeTruthy();
  });
});
