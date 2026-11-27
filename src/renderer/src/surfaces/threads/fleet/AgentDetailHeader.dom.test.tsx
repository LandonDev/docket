// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { tooltipChunk, warmTooltips } from "../../../components/ui/tooltip";
import { AgentDetailHeader } from "./AgentDetailHeader";
import { FLEET } from "./fleetFixture";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("AgentDetailHeader", () => {
  it("a working agent says Working on a still dot, its phase left to the transcript's working line", () => {
    const { container } = render(
      <AgentDetailHeader meta={FLEET[0].meta} status={{ state: "working", detail: "Thinking", phrase: true }} parts={[]} />,
    );
    const mark = container.querySelector<HTMLElement>('[data-slot="status-mark"]')!;
    expect(mark.dataset.state).toBe("working");
    expect(mark.textContent).toBe("Working");
    expect(container.querySelector('[data-slot="spinner"]')).toBeNull();
    expect(container.querySelector('[data-slot="working-dot"]')).not.toBeNull();
  });
  it("any other state keeps its word and what it is about", () => {
    const { container } = render(
      <AgentDetailHeader meta={FLEET[0].meta} status={{ state: "waiting", detail: "Approve Bash", phrase: false }} parts={[]} />,
    );
    expect(container.querySelector('[data-slot="status-mark"]')!.textContent).toBe("Needs youApprove Bash");
  });
  it("a long question keeps the glyph on its first line, by the word", () => {
    const { container } = render(
      <AgentDetailHeader meta={FLEET[0].meta} status={{ state: "waiting", detail: "Should the phone's cache use bun:sqlite through the bridge, or GRDB with its own migrations?", phrase: false }} parts={[]} />,
    );
    const mark = container.querySelector<HTMLElement>('[data-slot="status-mark"]')!.className.split(" ");
    // The glyph's own box centres itself (`self-center`): the sheet's mark puts it at the top, 1px down the 16px line.
    expect(mark).toEqual(expect.arrayContaining(["items-start", "[&>[data-slot=status-glyph]]:self-start", "[&>[data-slot=status-glyph]]:mt-px"]));
  });
  it("mounts no tooltip while the name fits", async () => {
    await act(async () => {
      await tooltipChunk.load();
      warmTooltips();
    });
    const { container } = render(<AgentDetailHeader meta={FLEET[0].meta} status={{ state: "done", detail: undefined, phrase: false }} parts={[]} />);
    expect(container.querySelector("h2")!.getAttribute("data-slot")).toBeNull();
  });
  it("puts the whole name in a tooltip when the sheet's width cuts it", async () => {
    vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockReturnValue(400);
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(100);
    const title = "Review the transcript outline's fold, the agents sheet and Search across every host";
    const { container } = render(
      <AgentDetailHeader meta={{ ...FLEET[0].meta, title }} status={{ state: "done", detail: undefined, phrase: false }} parts={[]} />,
    );
    await act(async () => {
      warmTooltips();
      await tooltipChunk.load();
    });
    const heading = container.querySelector("h2")!;
    expect(heading.className).toContain("truncate");
    expect(heading.getAttribute("data-slot")).toBe("tooltip-trigger");
    expect(heading.textContent).toBe(title);
  });
});
