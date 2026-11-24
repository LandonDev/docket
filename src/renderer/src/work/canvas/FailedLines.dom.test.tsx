// @vitest-environment jsdom
/**
 * The canvas pane's failure and its quiet line (docs/DESIGN.md "The canvas pane"): a failed open names the pane's
 * computer when the link is down, and a cut read-only reason can be read whole, on hover and from the keyboard.
 */
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { tooltipChunk, warmTooltips } from "../../components/ui/tooltip";
vi.mock("../../lib/connection/registry", async (original) => ({
  ...(await original<typeof import("../../lib/connection/registry")>()),
  registry: { environment: (id: string) => (id === "env_box" ? { id, name: "The box", platform: "linux" } : undefined) },
}));
const { FailedHost, OpenFailed } = await import("./FetchState");
import { QuietLine } from "./QuietLine";

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

describe("a failed open", () => {
  it("names the pane's computer when the link is down", () => {
    render(
      <FailedHost.Provider value="env_box">
        <OpenFailed kind="document" why="Not connected" onRetry={() => undefined} />
      </FailedHost.Provider>,
    );
    expect(screen.getByText("Couldn't open this document")).toBeTruthy();
    expect(screen.getByText("The box is not connected. Try again once it is back.")).toBeTruthy();
  });

  it("keeps the bare word where no computer is known", () => {
    render(
      <FailedHost.Provider value="env_gone">
        <OpenFailed kind="document" why="Not connected" />
      </FailedHost.Provider>,
    );
    expect(screen.getByText("Not connected")).toBeTruthy();
  });
});

describe("a quiet line's cut reason", () => {
  it("is a Tab stop with its whole words in a tooltip", () => {
    const reason = "Moved to Esports Staff › Events › Spring LAN 2027 › Budget final final.xlsx";
    vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(function (this: HTMLElement) {
      return this.textContent === reason ? 900 : 0;
    });
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (this: HTMLElement) {
      return this.textContent === reason ? 200 : 0;
    });
    render(<QuietLine word="Read only" detail={reason} />);
    const detail = screen.getByText(reason);
    expect(detail.getAttribute("tabindex")).toBe("0");
    expect(detail.getAttribute("data-slot")).toBe("tooltip-trigger");
  });
});
