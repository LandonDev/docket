// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, renderHook, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { awayStateOf } from "@server/shared/away";

const host = vi.hoisted(() => ({
  set: vi.fn(async (_params: unknown): Promise<unknown> => ({})),
  workOn: true,
}));

vi.mock("../../lib/sounds", () => ({ playCue: () => {} }));
vi.mock("../../lib/workSwitch", () => ({ useWorkOn: () => host.workOn }));
vi.mock("../../components/ui/toaster", () => ({ loadToast: async () => Object.assign(() => {}, { error: () => {} }) }));
vi.mock("../../chrome/AwayReviewDialog", () => ({
  AwayReviewDialog: ({ threads, onOpen }: { threads: { sessionId: string; count: number }[]; onOpen: (id: string, env: string) => void }) => (
    <div role="dialog" aria-label="Decided while you were away">
      {threads.map((t) => (
        <button key={t.sessionId} onClick={() => onOpen(t.sessionId, "local")}>
          {t.sessionId}
        </button>
      ))}
    </div>
  ),
}));
vi.mock("../../lib/connection/registry", () => ({
  registry: {
    primaryEnvironmentId: "local",
    onLink: () => () => {},
    linkOf: () => ({ request: (method: string, params: unknown) => (method === "away.set" ? host.set(params) : Promise.resolve({})) }),
  },
}));
vi.mock("../../lib/connection", () => ({ registry: { primaryEnvironmentId: "local" } }));

const { AwayPage } = await import("./Away");
const { awayStore, resetAwayForTest, useAway } = await import("../../lib/away");

const off = (at: number) => awayStateOf({ code: false, work: false }, at, "mac");

beforeEach(() => {
  host.set.mockReset();
  host.workOn = true;
  resetAwayForTest({ hosts: { local: { state: off(1), decided: { since: 0, threads: [] } } } });
});
afterEach(cleanup);

describe("Away", () => {
  it("flipping Work threads on the page changes what the rail reads and sends one away.set", async () => {
    host.set.mockImplementation(async (params) => ({ state: awayStateOf({ code: false, work: true }, 5, "mac"), params }));
    const rail = renderHook(() => useAway());
    render(<AwayPage />);
    await act(async () => {
      fireEvent.click(screen.getByRole("switch", { name: "Work threads" }));
    });
    expect(host.set).toHaveBeenCalledTimes(1);
    expect(host.set).toHaveBeenCalledWith(expect.objectContaining({ work: true }));
    expect(rail.result.current.work).toBe(true);
    expect(rail.result.current.code).toBe(false);
    expect((document.querySelector("[data-setting='away.work']") as HTMLElement).textContent).toContain("Saved");
  });

  it("shows Work threads only while some computer has Work on", () => {
    host.workOn = false;
    render(<AwayPage />);
    expect(screen.queryByRole("switch", { name: "Work threads" })).toBeNull();
    expect(screen.getByRole("switch", { name: "Code threads" })).toBeTruthy();
  });

  it("puts a refused flip back, leaving the reason to the store's toast", async () => {
    host.set.mockImplementation(async () => {
      throw new Error("forbidden: away.set needs approve");
    });
    render(<AwayPage />);
    await act(async () => {
      fireEvent.click(screen.getByRole("switch", { name: "Code threads" }));
    });
    expect(screen.getByRole("switch", { name: "Code threads" }).getAttribute("aria-checked")).toBe("false");
    expect(screen.queryByText("This did not save.")).toBeNull();
  });
});

describe("Last time away", () => {
  it("is absent before any stretch away has ended", () => {
    render(<AwayPage />);
    expect(document.querySelector("[data-setting='away.last']")).toBeNull();
  });

  it("is absent while away", () => {
    awayStore.setState({ hosts: { local: { state: awayStateOf({ code: true, work: false }, 9, "mac"), decided: { since: 9, threads: [{ sessionId: "s1", count: 2 }] } } } });
    render(<AwayPage />);
    expect(document.querySelector("[data-setting='away.last']")).toBeNull();
  });

  it("says when it ended and how many decisions were made, on every computer, and opens their list", async () => {
    const ended = new Date().setHours(9, 5, 0, 0);
    awayStore.setState({
      hosts: {
        local: { state: off(ended), decided: { since: 1, threads: [{ sessionId: "s1", count: 2 }] } },
        env_box: { state: off(ended), decided: { since: 1, threads: [{ sessionId: "s2", count: 1 }, { sessionId: "s3", count: 0 }] } },
      },
    });
    const onOpenSession = vi.fn();
    render(<AwayPage onOpenSession={onOpenSession} />);
    const row = document.querySelector("[data-setting='away.last']") as HTMLElement;
    expect(row.textContent).toContain("Last time away");
    expect(row.textContent).toMatch(/Ended 9:05\s?AM, 3 decisions made for you/);
    await act(async () => {
      fireEvent.click(within(row).getByRole("button", { name: "Last time away" }));
    });
    const list = screen.getByRole("dialog", { name: "Decided while you were away" });
    expect(within(list).getAllByRole("button").map((b) => b.textContent)).toEqual(["s1", "s2"]);
    fireEvent.click(within(list).getByRole("button", { name: "s2" }));
    expect(onOpenSession).toHaveBeenCalledWith("s2");
  });

  it("says so when nothing was decided, with nothing to open", () => {
    awayStore.setState({ hosts: { local: { state: off(new Date().setHours(9, 5, 0, 0)), decided: { since: 1, threads: [] } } } });
    render(<AwayPage />);
    const row = document.querySelector("[data-setting='away.last']") as HTMLElement;
    expect(row.textContent).toContain("no decisions made for you");
    expect(within(row).queryByRole("button")).toBeNull();
  });
});
