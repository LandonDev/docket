// @vitest-environment jsdom
/** A Work view that throws is its own error with Retry, which mounts it again; never the window's. */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registry } from "../../lib/connection";
import { resetLifeos, setLifeosStatus } from "./lifeos";

vi.mock("../../lib/tcserver/workspaces", async (original) => ({
  ...(await original<object>()),
  useWorkspaces: () => [{ id: "ws", name: "Purdue Esports", environmentId: "env_box", sector: "purdue", kind: "work", path: "/w" }],
}));
vi.mock("convex/react", async (original) => ({ ...(await original<object>()), ConvexReactClient: class {} }));

const { ViewBoundary, ViewFrame } = await import("./WorkViewPage");

afterEach(() => {
  cleanup();
  resetLifeos();
  vi.restoreAllMocks();
});
const flush = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));

describe("the view frame's line", () => {
  it("reads the session: a JWT unanswered while the host says connected is the 32px state line, not bones, and Retry asks again", async () => {
    const asked: string[] = [];
    vi.spyOn(registry, "linkOf").mockReturnValue({
      environmentId: "env_box",
      connected: true,
      onPush: () => () => {},
      onOpen: () => () => {},
      request: vi.fn(async (method: string) => {
        asked.push(method);
        if (method === "work.lifeos.status") return { lifeos: { state: "connected", ownerId: "landon", since: 1 }, keys: [] };
        throw new Error("socket closed");
      }),
    } as never);
    setLifeosStatus("env_box", { lifeos: { state: "connected", ownerId: "landon", since: 1 }, keys: [] });
    render(<ViewFrame view="tasks" environmentId="env_box" workspaceId="ws" sector="purdue" />);
    await flush();
    await flush();
    const line = document.querySelector("[data-view-state=failed]") as HTMLElement;
    expect(line.textContent).toContain("LifeOS did not answer");
    expect(line.className).toContain("min-h-8");
    // Once the view's chunk lands, nothing pulses under the line.
    await vi.waitFor(() => expect(document.querySelector("[aria-busy], [aria-hidden=true]")).toBeNull(), { timeout: 5000 });
    const before = asked.filter((m) => m === "work.lifeos.jwt").length;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await flush();
    expect(asked).toContain("work.lifeos.status");
    expect(asked.filter((m) => m === "work.lifeos.jwt").length).toBe(before + 1);
  });
});

describe("a view's boundary", () => {
  it("shows what failed with Retry, and Retry mounts the view again", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    let fail = true;
    function Tasks() {
      if (fail) throw new Error("LifeOS refused the read");
      return <p>The tasks</p>;
    }
    render(
      <ViewBoundary label="Tasks">
        <Tasks />
      </ViewBoundary>,
    );
    expect(screen.getByText("Tasks did not load")).toBeTruthy();
    expect(screen.getByText("LifeOS refused the read")).toBeTruthy();
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(screen.getByText("The tasks")).toBeTruthy();
  });
});
