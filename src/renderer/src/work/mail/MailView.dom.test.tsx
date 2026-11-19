// @vitest-environment jsdom
/**
 * The Mail view's frame: its own list-and-pane bones while the session
 * opens, nothing under the frame's line when LifeOS fails, and under 640px
 * of pane the list or the open mail with a Mail row back.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MailFrame, View } from "./MailView";

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

  it("narrow, shows the list until a mail opens, then the mail with a Mail row back", () => {
    const back = vi.fn();
    const { rerender } = render(<MailFrame list={<p>The list</p>} pane={<p>The pane</p>} reading={false} onBack={null} />);
    const list = () => document.querySelector("[data-mail-list]")!.className;
    const pane = () => document.querySelector("[data-mail-pane]")!.className;
    expect(list()).not.toContain("@max-[40rem]/mail:hidden");
    expect(pane()).toContain("@max-[40rem]/mail:hidden");
    rerender(<MailFrame list={<p>The list</p>} pane={<p>The pane</p>} reading onBack={back} />);
    expect(list()).toContain("@max-[40rem]/mail:hidden");
    expect(pane()).not.toContain("@max-[40rem]/mail:hidden");
    fireEvent.click(screen.getByRole("button", { name: "Mail" }));
    expect(back).toHaveBeenCalled();
  });
});
