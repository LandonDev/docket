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
vi.mock("../../stores/project", async (original) => ({ ...(await original<object>()), useSelectedWorkspaceIds: () => ["ws"] }));
const files = vi.hoisted(() => ({ opened: [] as unknown[][] }));
vi.mock("../files/openFrom", async (original) => ({ ...(await original<object>()), openInFiles: async (...args: unknown[]) => void files.opened.push(args) }));

const { ViewBoundary, ViewFrame, WorkViewSurface } = await import("./WorkViewPage");
const { openWorkView } = await import("../../lib/workSwitch");
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

describe("what stands between a view and LifeOS", () => {
  const quiet = () =>
    vi.spyOn(registry, "linkOf").mockReturnValue({ environmentId: "env_box", connected: true, onPush: () => () => {}, onOpen: () => () => {}, request: vi.fn(async () => new Promise(() => {})) } as never);
  it("Work off on the host says so with Settings, never a sign-in", async () => {
    quiet();
    setLifeosStatus("env_box", { lifeos: { state: "off" }, keys: [] });
    render(<ViewFrame view="tasks" environmentId="env_box" workspaceId="ws" sector="purdue" />);
    await flush();
    expect(screen.getByText(/^Work is off on /)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open Settings" })).toBeTruthy();
    expect(screen.queryByText("Sign in to LifeOS")).toBeNull();
  });
  it("signed out, Sign in opens the sign-in dialog in place; a sign-in waiting says so and shows its code", async () => {
    quiet();
    setLifeosStatus("env_box", { lifeos: { state: "signed-out" }, keys: [] });
    const view = render(<ViewFrame view="tasks" environmentId="env_box" workspaceId="ws" sector="purdue" />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await vi.waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy(), { timeout: 5000 });
    view.unmount();
    setLifeosStatus("env_box", { lifeos: { state: "pairing", code: "ABCD-1234", expiresAt: Date.now() + 60_000 }, keys: [] });
    render(<ViewFrame view="tasks" environmentId="env_box" workspaceId="ws" sector="purdue" />);
    await flush();
    expect(screen.getByText("The LifeOS sign-in waits for your approval")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Show the code" })).toBeTruthy();
  });
  it("a host never heard from and not connected is named with Retry, not bones for ever", async () => {
    quiet();
    vi.spyOn(registry, "statusOf").mockReturnValue({ transport: "offline", fresh: false, lastHello: null, lastError: null, nextRetryAt: null, route: null } as never);
    const retry = vi.spyOn(registry, "retry").mockImplementation(() => {});
    render(<ViewFrame view="tasks" environmentId="env_box" workspaceId="ws" sector="purdue" />);
    await flush();
    expect(screen.getByText(/ is not connected$/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(retry).toHaveBeenCalledWith("env_box");
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

describe("a view over the thread's pane", () => {
  const host = () =>
    vi.spyOn(registry, "linkOf").mockReturnValue({
      environmentId: "env_box",
      connected: true,
      onPush: () => () => {},
      onOpen: () => () => {},
      request: vi.fn(async (method: string) => (method === "work.routines.list" ? { routines: [] } : { lifeos: { state: "connected", ownerId: "landon", since: 1 }, keys: [] })),
    } as never);
  const Main = ({ view }: { view: boolean }) => (
    <>
      <button type="button">A thread in the strip</button>
      <div data-main>
        <div data-pane>
          <textarea aria-label="Composer" />
        </div>
        {view ? <ViewFrame view="routines" environmentId="env_box" workspaceId="ws" sector="purdue" /> : null}
      </div>
    </>
  );

  it("takes the focus to its heading when the focus was in the pane it covers", async () => {
    host();
    const view = render(<Main view={false} />);
    screen.getByRole("textbox", { name: "Composer" }).focus();
    view.rerender(<Main view />);
    await flush();
    expect(document.activeElement).toBe(document.querySelector("[data-view-heading]"));
    expect(document.querySelector("[data-view-heading]")!.textContent).toBe("Routines");
  });

  it("leaves the focus where it was outside the pane: the thread strip stays his", async () => {
    host();
    const view = render(<Main view={false} />);
    const strip = screen.getByRole("button", { name: "A thread in the strip" });
    strip.focus();
    view.rerender(<Main view />);
    await flush();
    expect(document.activeElement).toBe(strip);
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
    const was = WORK_VIEWS.people.chunk;
    WORK_VIEWS.people.chunk = defineChunk("test-people", async () => {
      if (tries++ === 0) throw new Error("chunk missing");
      return { View: () => <p>The people</p> };
    }) as never;
    try {
      render(<ViewFrame view="people" environmentId="env_box" workspaceId="ws" sector="purdue" />);
      await vi.waitFor(() => expect(screen.getByText("People did not load")).toBeTruthy());
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
      await vi.waitFor(() => expect(screen.getByText("The people")).toBeTruthy());
      expect(tries).toBe(2);
    } finally {
      WORK_VIEWS.people.chunk = was;
    }
  });
});

describe("a view that draws its own head", () => {
  it("has no 40px header over Mail's list head; the region names the view and takes the focus from the pane it covers, and the sign-in keeps the header", async () => {
    vi.spyOn(registry, "linkOf").mockReturnValue({ environmentId: "env_box", connected: true, onPush: () => () => {}, onOpen: () => () => {}, request: vi.fn(async () => ({})) } as never);
    setLifeosStatus("env_box", { lifeos: { state: "connected", ownerId: "landon", since: 1 }, keys: [] });
    expect(WORK_VIEWS.mail.ownHead).toBe(true);
    const was = WORK_VIEWS.mail.chunk;
    WORK_VIEWS.mail.chunk = defineChunk("test-mail", async () => ({ View: () => <p>The list's head</p> })) as never;
    try {
      const Main = ({ view }: { view: boolean }) => (
        <div data-main>
          <textarea aria-label="Composer" />
          {view ? <ViewFrame view="mail" environmentId="env_box" workspaceId="ws" sector="purdue" /> : null}
        </div>
      );
      const page = render(<Main view={false} />);
      screen.getByRole("textbox", { name: "Composer" }).focus();
      page.rerender(<Main view />);
      await vi.waitFor(() => expect(screen.getByText("The list's head")).toBeTruthy());
      const region = screen.getByRole("region", { name: "Mail" });
      expect(region.querySelector("[data-view-heading]")).toBeNull();
      expect(region.querySelector(".h-10")).toBeNull();
      expect(document.activeElement).toBe(region);
      act(() => setLifeosStatus("env_box", { lifeos: { state: "signed-out" }, keys: [] }));
      expect(screen.getByText("Sign in to LifeOS")).toBeTruthy();
      expect(region.querySelector("[data-view-heading]")!.textContent).toBe("Mail");
    } finally {
      WORK_VIEWS.mail.chunk = was;
    }
  });
});

describe("a way in that still names Docs", () => {
  it("opens the document in a Files tab, or stands on the LifeOS place, from a view kept or sent before Docs folded into Files", async () => {
    render(<WorkViewSurface />);
    await act(async () => openWorkView({ workspaceId: "ws", view: "docs", doc: { id: "d1", title: "Run of show" } }));
    await vi.waitFor(() => expect(files.opened).toHaveLength(1));
    await act(async () => openWorkView({ workspaceId: "ws", view: "docs" }));
    await vi.waitFor(() => expect(files.opened).toHaveLength(2));
    const at = { id: "ws", environmentId: "env_box" };
    expect(files.opened).toEqual([
      [at, { ref: { at: "lifeos", table: "docs", id: "d1" }, name: "Run of show" }],
      [at, { page: { at: { at: "place", id: "lifeos" }, name: "LifeOS" } }],
    ]);
    openWorkView(null);
  });
});
