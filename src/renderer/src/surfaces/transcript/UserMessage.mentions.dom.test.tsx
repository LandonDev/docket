// @vitest-environment jsdom
/** A thread mention in the person's bubble: a known one is a chip that opens it, an unknown one is never its id. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";

vi.mock("../../lib/threadMentions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/threadMentions")>()),
  useThreadTitles: () => (id: string) => (id === "abcdef123456" ? "Auth rewrite" : undefined),
}));

import { MENTION_CHIP, UserText } from "./UserMessage";
import { SelectSessionContext } from "../AgentMarkdown";

afterEach(cleanup);

describe("UserText thread mentions", () => {
  it("a known thread is a chip that opens it, its hit area 24px on the line's height", () => {
    const open = vi.fn();
    const { getByRole } = render(
      <SelectSessionContext.Provider value={open}>
        <UserText text="see @thread:abcdef123456 now" />
      </SelectSessionContext.Provider>,
    );
    const chip = getByRole("button", { name: "Auth rewrite" });
    for (const cls of MENTION_CHIP.split(" ")) expect(chip.className.split(" ")).toContain(cls);
    expect(chip.className).toContain("after:-inset-y-0.5");
    expect(chip.className).toContain("h-auto");
    fireEvent.click(chip);
    expect(open).toHaveBeenCalledWith("abcdef123456");
  });

  it("an unknown thread reads Thread, muted, and never shows its id or token", () => {
    const { container, queryByRole } = render(<UserText text="see @thread:strip-pass-1 now" />);
    expect(container.textContent).toBe("see Thread now");
    expect(container.textContent).not.toContain("strip-pass-1");
    const chip = container.querySelector('[data-slot="thread-mention-unknown"]')!;
    expect(chip.className).toContain("text-muted-foreground");
    expect(queryByRole("button")).toBeNull();
  });
});
