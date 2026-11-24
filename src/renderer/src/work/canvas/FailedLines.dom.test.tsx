// @vitest-environment jsdom
/**
 * The canvas pane's failure and its quiet line (docs/DESIGN.md "The canvas pane"): a failed open names the pane's
 * computer when the link is down, the state line words a host's reason the same way, and a cut read-only reason can
 * be read whole, on hover and from the keyboard.
 */
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { tooltipChunk, warmTooltips } from "../../components/ui/tooltip";
vi.mock("../../lib/connection/registry", async (original) => ({
  ...(await original<typeof import("../../lib/connection/registry")>()),
  registry: { environment: (id: string) => (id === "env_box" ? { id, name: "The box", platform: "linux" } : undefined), onLink: () => () => undefined },
}));
const { FailedHost, OpenFailed } = await import("./FetchState");
const { StateLine } = await import("./CanvasPane");
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

describe("the state line's reason", () => {
  const line = (detail: string, env = "env_box") =>
    render(
      <FailedHost.Provider value={env}>
        <StateLine line={{ tone: "failed", word: "Couldn't save", detail }} />
      </FailedHost.Provider>,
    ).container.textContent;

  it("words a host's reason as the failed open does, naming the pane's computer", () => {
    expect(line("connection closed")).toBe("Couldn't saveThe connection to the box dropped. Try again once it is back.");
    cleanup();
    expect(line("Not connected")).toBe("Couldn't saveThe box is not connected. Try again once it is back.");
    cleanup();
    expect(line("work.sheets.write timed out after 30 s")).toBe("Couldn't saveThe box did not answer. Try again once it is connected.");
  });

  it("shows no detail for a raw reason, and a plain one as it is", () => {
    expect(line("ENOTDIR: /srv/agents/work/Budget.xlsx")).toBe("Couldn't save");
    cleanup();
    expect(line("Read only, as of 2:04 PM")).toBe("Couldn't saveRead only, as of 2:04 PM");
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
