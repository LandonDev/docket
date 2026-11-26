// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LoadEarlierButton } from "./LoadEarlier";

afterEach(cleanup);

describe("LoadEarlierButton", () => {
  it("spins from the press until the page lands, and a second press sends nothing", async () => {
    let land!: () => void;
    const onLoad = vi.fn(() => new Promise<void>((resolve) => (land = resolve)));
    render(<LoadEarlierButton variant="secondary" size="sm" onLoad={onLoad} label="Load earlier messages" busyLabel="Loading…" />);
    const button = screen.getByRole("button");
    expect(button.querySelector('[data-slot="busy-label"]')!.getAttribute("data-busy")).toBeNull();
    fireEvent.click(button);
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect(button.querySelector('[data-slot="busy-label"]')!.getAttribute("data-busy")).toBe("true");
    expect(button.textContent).toContain("Loading…");
    fireEvent.click(button);
    expect(onLoad).toHaveBeenCalledTimes(1);
    await act(async () => land());
    expect(button.getAttribute("aria-busy")).toBeNull();
    expect(button.textContent).toBe("Load earlier messages");
  });

  it("a page that fails puts the button back", async () => {
    let fail!: () => void;
    render(<LoadEarlierButton onLoad={() => new Promise<void>((_, reject) => (fail = () => reject(new Error("x"))))} label="Earlier messages" />);
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByRole("button").getAttribute("aria-busy")).toBe("true");
    await act(async () => fail());
    expect(screen.getByRole("button").getAttribute("aria-busy")).toBeNull();
  });

  it("a load with nothing to wait on never spins", () => {
    render(<LoadEarlierButton onLoad={() => undefined} label="Earlier messages" />);
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByRole("button").getAttribute("aria-busy")).toBeNull();
  });
});
