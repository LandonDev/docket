// @vitest-environment jsdom
/**
 * Council round 1, sitting B: an Agenda row's hover verb fades the title into the row's own fill on the title's line
 * (R1-B14, R1-B15), and a title or place the column cuts is said whole on the row's hover and focus (R1-B19).
 */
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { tooltipChunk, warmTooltips } from "../../components/ui/tooltip";
import type { AgendaEvent } from "../tasks/client";

const { EventRow } = await import("./AgendaView");

beforeAll(async () => {
  await act(async () => {
    await tooltipChunk.load();
    warmTooltips();
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const event = { _id: "e1", title: "Walk the venue with Dana before the doors open", location: "Purdue Memorial Union ballroom", startsAt: Date.UTC(2026, 10, 27, 19), endsAt: Date.UTC(2026, 10, 27, 20) } as unknown as AgendaEvent;

function draw(cut: (el: HTMLElement) => boolean) {
  vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(function (this: HTMLElement) {
    return cut(this) ? 300 : 100;
  });
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(100);
  return render(<EventRow event={event} past={false} leave={undefined} clashes={undefined} day={event.startsAt} onPrepare={() => {}} people={[]} workspaceId="ws" environmentId="box" />);
}

async function tipOf(container: HTMLElement): Promise<Element | null> {
  await act(async () => {
    container.querySelector<HTMLElement>("[data-row-open]")!.focus();
    await new Promise((r) => setTimeout(r, 50));
  });
  return document.querySelector('[data-slot="tooltip-content"]');
}

describe("an Agenda row", () => {
  it("draws no tip while nothing is cut", async () => {
    const { container } = draw(() => false);
    expect(await tipOf(container)).toBeNull();
  });

  it("says the title and the place whole while the column cuts one", async () => {
    const { container } = draw((el) => el.textContent === event.location && el.classList.contains("truncate"));
    const tip = await tipOf(container);
    expect(tip?.textContent).toContain(event.title);
    expect(tip?.textContent).toContain(event.location);
  });

  it("fades the title into the tinted fill, the verb's press on the title's line", () => {
    const { container } = draw(() => false);
    const verb = container.querySelector<HTMLElement>("[data-event-verb]")!;
    expect(verb.className).toContain("top-1 ");
    expect(verb.className).not.toContain("ps-3");
    expect(verb.firstElementChild!.className).toContain("ps-3");
    expect(verb.firstElementChild!.className).toContain("group-hover/row:bg-foreground/5");
  });
});
