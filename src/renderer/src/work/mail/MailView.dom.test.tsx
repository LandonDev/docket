// @vitest-environment jsdom
/**
 * The Mail view's frame: its own list-and-pane bones while the session
 * opens, nothing under the frame's line when LifeOS fails, and the edge
 * between the list and the pane, which takes a drag and the arrow keys
 * within its bounds and is kept for the app.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clampList, LIST_WIDTH, MailFrame, View } from "./MailView";

beforeEach(() => localStorage.clear());
afterEach(cleanup);

const props = (state: string) => ({ env: "box", workspace: { id: "ws", environmentId: "box" }, sector: "purdue", lifeos: { environmentId: "box", sector: "purdue", client: null, state }, startThread: () => {} }) as never;

describe("the Mail view", () => {
  it("draws its own list and pane bones while the session opens, and nothing when LifeOS did not answer", () => {
    const { container, rerender } = render(<View {...props("connecting")} />);
    const bones = screen.getByRole("status", { name: "Loading Mail" });
    expect(bones.querySelector("[data-surface-skeleton=rows]")).toBeTruthy();
    expect(container.querySelector("[data-surface-skeleton=page]")).toBeNull();
    rerender(<View {...props("unreachable")} />);
    expect(container.textContent).toBe("");
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("sets the list 296px wide beside the pane, and marks the two halves", () => {
    render(<MailFrame list={<p>The list</p>} pane={<p>The pane</p>} />);
    const list = document.querySelector<HTMLElement>("[data-mail-list]")!;
    expect(list.style.width).toBe("296px");
    expect(list.textContent).toBe("The list");
    expect(document.querySelector("[data-mail-pane]")!.textContent).toBe("The pane");
  });

  it("keeps the list between 260 and 480px", () => {
    expect(clampList(100)).toBe(LIST_WIDTH.min);
    expect(clampList(900)).toBe(LIST_WIDTH.max);
    expect(clampList(333.4)).toBe(333);
  });

  it("moves the edge with the arrow keys, 16px a press, never past its bounds, and keeps the width for the app", () => {
    render(<MailFrame list={<p>The list</p>} pane={<p>The pane</p>} />);
    const edge = screen.getByRole("separator", { name: "Resize the list" });
    const width = () => document.querySelector<HTMLElement>("[data-mail-list]")!.style.width;
    expect(edge.getAttribute("aria-valuenow")).toBe("296");
    fireEvent.keyDown(edge, { key: "ArrowRight" });
    expect(width()).toBe("312px");
    expect(localStorage.getItem(LIST_WIDTH.key)).toBe("312");
    for (let i = 0; i < 20; i++) fireEvent.keyDown(edge, { key: "ArrowRight" });
    expect(width()).toBe("480px");
    for (let i = 0; i < 20; i++) fireEvent.keyDown(edge, { key: "ArrowLeft" });
    expect(width()).toBe("260px");
    expect(edge.getAttribute("aria-valuenow")).toBe("260");
    // A double press puts it back.
    fireEvent.doubleClick(edge);
    expect(width()).toBe("296px");
  });

  it("opens at the width the app kept, and reads a kept width that makes no sense as the default", () => {
    localStorage.setItem(LIST_WIDTH.key, "420");
    const first = render(<MailFrame list={null} pane={null} />);
    expect(document.querySelector<HTMLElement>("[data-mail-list]")!.style.width).toBe("420px");
    first.unmount();
    localStorage.setItem(LIST_WIDTH.key, "wide");
    render(<MailFrame list={null} pane={null} />);
    expect(document.querySelector<HTMLElement>("[data-mail-list]")!.style.width).toBe("296px");
  });
});
