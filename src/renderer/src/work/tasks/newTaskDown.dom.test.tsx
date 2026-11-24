// @vitest-environment jsdom
/**
 * Council round 5 (Sol P1, Opus P2): New task pressed while the LifeOS session was on its way, which then went down,
 * opened its dialog by itself once the session came back. A press its body cannot answer now is dropped, and the
 * header offers none while the session is down.
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeTasksClient } from "work-kit/views";
import type { LifeosSession } from "../shell/lifeos";

vi.mock("./NewTaskDialog", () => ({ NewTaskDialog: () => <div data-new-task-dialog /> }));
vi.mock("./client", async (original) => ({ ...(await original<object>()), viewsClients: () => ({ tasks: fakeTasksClient([]) }) }));
vi.mock("convex/react", async (original) => ({ ...(await original<object>()), ConvexProvider: ({ children }: { children: unknown }) => children, useQuery: () => undefined }));

const { Head, View } = await import("./TasksView");

afterEach(cleanup);

const WAITS: LifeosSession = { environmentId: "box", sector: "purdue", client: null, state: "connected" };
const DOWN: LifeosSession = { environmentId: "box", sector: "purdue", client: null, state: "unreachable", unanswered: true };
const READS: LifeosSession = { environmentId: "box", sector: "purdue", client: {} as never, state: "connected" };

function Frame({ lifeos }: { lifeos: LifeosSession }) {
  const props = { env: "box", workspace: { id: "ws" }, sector: "purdue", lifeos, startThread: () => {} } as never;
  return (
    <>
      <Head {...props} />
      <View {...props} />
    </>
  );
}

describe("New task while the session is down", () => {
  it("is not offered, and a press made while the session was on its way never opens by itself once it is back", async () => {
    const view = render(<Frame lifeos={WAITS} />);
    fireEvent.click(screen.getByRole("button", { name: "New task" }));
    expect(document.querySelector("[data-new-task-dialog]")).toBeNull();
    await act(async () => view.rerender(<Frame lifeos={DOWN} />));
    expect(screen.queryByRole("button", { name: "New task" })).toBeNull();
    await act(async () => view.rerender(<Frame lifeos={READS} />));
    expect(document.querySelector("[data-new-task-dialog]")).toBeNull();
    // A press while it reads opens the dialog at once.
    fireEvent.click(screen.getByRole("button", { name: "New task" }));
    expect(document.querySelector("[data-new-task-dialog]")).toBeTruthy();
  });

  it("answers a press made while the session was on its way once it reads", async () => {
    const view = render(<Frame lifeos={WAITS} />);
    fireEvent.click(screen.getByRole("button", { name: "New task" }));
    await act(async () => view.rerender(<Frame lifeos={READS} />));
    expect(document.querySelector("[data-new-task-dialog]")).toBeTruthy();
  });
});
