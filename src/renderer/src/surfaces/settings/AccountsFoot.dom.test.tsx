// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ workOn: true, request: vi.fn() }));
vi.mock("../../lib/workSwitch", () => ({ useWorkOn: () => state.workOn }));
vi.mock("../../lib/monaco/debugTab", () => ({ requestSettings: (...args: unknown[]) => state.request(...args) }));

const { AccountsFoot } = await import("./AccountsFoot");

afterEach(cleanup);

describe("AI accounts' foot", () => {
  it("is one open row to Connections, where Work's sign-ins live", () => {
    render(<AccountsFoot />);
    const row = document.querySelector("[data-setting='accounts.connections']") as HTMLElement;
    expect(row.textContent).toContain("LifeOS, Office and Google sign-ins");
    fireEvent.click(screen.getByRole("button", { name: "LifeOS, Office and Google sign-ins" }));
    expect(state.request).toHaveBeenCalledWith("connections");
  });

  it("is absent while Work is off everywhere", () => {
    state.workOn = false;
    render(<AccountsFoot />);
    expect(document.querySelector("[data-setting='accounts.connections']")).toBeNull();
    state.workOn = true;
  });
});
