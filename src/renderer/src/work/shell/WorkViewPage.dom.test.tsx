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
const { WORK_VIEWS } = await import("../views/registry");
const { defineChunk } = await import("../../lib/lazyChunk");

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

describe("a view opened before its chunk has landed", () => {
  it("draws its header's controls and its own title once the chunk lands, in place of the bare name", async () => {
    vi.spyOn(registry, "linkOf").mockReturnValue({ environmentId: "env_box", connected: true, onPush: () => () => {}, onOpen: () => () => {}, request: vi.fn(async () => ({})) } as never);
    setLifeosStatus("env_box", { lifeos: { state: "connected", ownerId: "landon", since: 1 }, keys: [] });
    let land: (module: object) => void = () => {};
    const was = WORK_VIEWS.agenda.chunk;
    WORK_VIEWS.agenda.chunk = defineChunk("test-agenda", () => new Promise((resolve) => (land = resolve))) as never;
    try {
      render(<ViewFrame view="agenda" environmentId="env_box" workspaceId="ws" sector="purdue" />);
      await flush();
      // Not landed: the view's name, and no control.
      expect(screen.getByRole("region", { name: "Agenda" }).textContent).toContain("Agenda");
      expect(screen.queryByRole("button", { name: "A verb" })).toBeNull();
      await act(async () => {
        land({ View: () => <p>The week</p>, Head: () => <button type="button">A verb</button>, Title: () => <span>The way back</span> });
        await new Promise((r) => setTimeout(r, 0));
      });
      await vi.waitFor(() => expect(screen.getByRole("button", { name: "A verb" })).toBeTruthy());
      expect(screen.getByText("The way back")).toBeTruthy();
      expect(screen.getByText("The week")).toBeTruthy();
    } finally {
      WORK_VIEWS.agenda.chunk = was;
    }
  });
});

describe("views outside LifeOS's gate, and a view that did not import", () => {
  it("draws Routines, its header and its body, while LifeOS is signed out: its data is the host's", async () => {
    vi.spyOn(registry, "linkOf").mockReturnValue({
      environmentId: "env_box",
      connected: true,
      onPush: () => () => {},
      onOpen: () => () => {},
      request: vi.fn(async (method: string) => (method === "work.routines.list" ? { routines: [] } : { lifeos: { state: "signed-out" }, keys: [] })),
    } as never);
    setLifeosStatus("env_box", { lifeos: { state: "signed-out" }, keys: [] });
    render(<ViewFrame view="routines" environmentId="env_box" workspaceId="ws" sector="purdue" />);
    await vi.waitFor(() => expect(screen.getByText("No routines yet")).toBeTruthy(), { timeout: 5000 });
    expect(screen.queryByText("Sign in to LifeOS")).toBeNull();
    expect(screen.getByRole("button", { name: "New routine" })).toBeTruthy();
  });

  it("imports the view again on Retry after its import failed", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(registry, "linkOf").mockReturnValue({ environmentId: "env_box", connected: true, onPush: () => () => {}, onOpen: () => () => {}, request: vi.fn(async () => ({})) } as never);
    setLifeosStatus("env_box", { lifeos: { state: "connected", ownerId: "landon", since: 1 }, keys: [] });
    let tries = 0;
    const was = WORK_VIEWS.docs.chunk;
    WORK_VIEWS.docs.chunk = defineChunk("test-docs", async () => {
      if (tries++ === 0) throw new Error("chunk missing");
      return { View: () => <p>The docs</p> };
    }) as never;
    try {
      render(<ViewFrame view="docs" environmentId="env_box" workspaceId="ws" sector="purdue" />);
      await vi.waitFor(() => expect(screen.getByText("Docs did not load")).toBeTruthy());
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
      await vi.waitFor(() => expect(screen.getByText("The docs")).toBeTruthy());
      expect(tries).toBe(2);
    } finally {
      WORK_VIEWS.docs.chunk = was;
    }
  });
});
