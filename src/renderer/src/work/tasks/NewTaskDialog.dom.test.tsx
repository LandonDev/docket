// @vitest-environment jsdom
/** New task draws no example words in its fields, and a refusal with no words of its own names the act, as New event's does. */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const lifeos = vi.hoisted(() => ({ add: vi.fn(async (_args: unknown): Promise<string> => "t1") }));
vi.mock("convex/react", async (original) => ({ ...(await original<object>()), useMutation: () => lifeos.add, ConvexProvider: ({ children }: { children: unknown }) => children }));
vi.mock("../jobName", () => ({ jobNameNow: () => "Purdue Esports" }));

const { NewTaskDialog } = await import("./NewTaskDialog");

afterEach(() => {
  cleanup();
  lifeos.add.mockClear();
});

describe("New task", () => {
  it("draws no example title: an empty field reads empty", () => {
    render(<NewTaskDialog sector="purdue" onClose={() => {}} />);
    expect(screen.getByRole("textbox", { name: "Task" }).getAttribute("placeholder")).toBeNull();
  });

  it("says LifeOS did not add the task when its refusal has no words of its own", async () => {
    lifeos.add.mockRejectedValueOnce(new Error("work.lifeos.call failed at /srv/x/y"));
    render(<NewTaskDialog sector="purdue" onClose={() => {}} />);
    fireEvent.change(screen.getByRole("textbox", { name: "Task" }), { target: { value: "Book the hall" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(screen.getByText("LifeOS did not add the task")).toBeTruthy());
  });

  it("says the same when Mail's Make task is refused", async () => {
    render(<NewTaskDialog sector="purdue" file={() => Promise.reject(new Error("[CONVEX M(tasks:make)] Server Error"))} onClose={() => {}} />);
    fireEvent.change(screen.getByRole("textbox", { name: "Task" }), { target: { value: "Book the hall" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(screen.getByText("LifeOS did not add the task")).toBeTruthy());
  });

  /** Council round 8 (Sol, Tasks 1 P1): a session that drops with the form open never takes what he typed. */
  it("keeps what he typed through a session that drops, says its line, and holds Add until the session reads again", async () => {
    const reads = { environmentId: "box", sector: "purdue" as const, client: {} as never, state: "connected" as const };
    const down = { environmentId: "box", sector: "purdue" as const, client: null, state: "unreachable" as const, unanswered: true as const };
    const view = render(<NewTaskDialog sector="purdue" session={reads} onClose={() => {}} />);
    fireEvent.change(screen.getByRole("textbox", { name: "Task" }), { target: { value: "Book the hall" } });
    await act(async () => view.rerender(<NewTaskDialog sector="purdue" session={down} onClose={() => {}} />));
    expect((screen.getByRole("textbox", { name: "Task" }) as HTMLInputElement).value).toBe("Book the hall");
    expect(document.querySelector('[data-session-down="unanswered"]')).toBeTruthy();
    expect((screen.getByRole("button", { name: "Add" }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => view.rerender(<NewTaskDialog sector="purdue" session={reads} onClose={() => {}} />));
    expect(document.querySelector("[data-session-down]")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(lifeos.add).toHaveBeenCalledWith(expect.objectContaining({ title: "Book the hall" })));
  });
  /** Council round 11 (the walk): while the host said connecting, Add was held with no line saying why. */
  it("names the wait while the host's LifeOS connects, keeps what he typed and holds Add, then adds once it reads", async () => {
    const { resetLifeos, setLifeosStatus } = await import("../shell/lifeos");
    try {
      act(() => setLifeosStatus("box", { lifeos: { state: "connecting" }, keys: [] } as never));
      const waiting = { environmentId: "box", sector: "purdue" as const, client: null, state: "connecting" as const };
      const reads = { environmentId: "box", sector: "purdue" as const, client: {} as never, state: "connected" as const };
      const view = render(<NewTaskDialog sector="purdue" session={waiting} onClose={() => {}} />);
      fireEvent.change(screen.getByRole("textbox", { name: "Task" }), { target: { value: "Book the hall" } });
      const wait = document.querySelector("[data-lifeos-waits]")!;
      expect(wait.textContent).toContain("LifeOS is still connecting");
      expect(wait.querySelector("button")).toBeNull();
      expect((screen.getByRole("button", { name: "Add" }) as HTMLButtonElement).disabled).toBe(true);
      act(() => setLifeosStatus("box", { lifeos: { state: "connected" }, keys: [] } as never));
      await act(async () => view.rerender(<NewTaskDialog sector="purdue" session={reads} onClose={() => {}} />));
      expect(document.querySelector("[data-lifeos-waits]")).toBeNull();
      expect((screen.getByRole("textbox", { name: "Task" }) as HTMLInputElement).value).toBe("Book the hall");
      fireEvent.click(screen.getByRole("button", { name: "Add" }));
      await waitFor(() => expect(lifeos.add).toHaveBeenCalledWith(expect.objectContaining({ title: "Book the hall" })));
    } finally {
      resetLifeos();
    }
  });
});
