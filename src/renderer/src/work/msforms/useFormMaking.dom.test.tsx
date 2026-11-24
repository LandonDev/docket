// @vitest-environment jsdom
/**
 * New → Microsoft Form's wait (useFormMaking): the state line says each stage of the make as the host tells it, and
 * a wait that ran out asks once more with the same press key, so the host answers the make it started.
 */
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const net = vi.hoisted(() => ({
  asks: [] as { method: string; params: Record<string, unknown> }[],
  listeners: new Set<(push: Record<string, unknown>) => void>(),
  answers: [] as (() => Promise<unknown>)[],
  opened: [] as unknown[],
}));
vi.mock("../../lib/connection", async (original) => {
  const real = await original<typeof import("../../lib/connection")>();
  const link = {
    request: async (method: string, params: Record<string, unknown>) => {
      net.asks.push({ method, params });
      if (method === "work.msforms.list") return { offered: true, forms: [] };
      return net.answers.shift()!();
    },
    onPush: (l: (push: Record<string, unknown>) => void) => (net.listeners.add(l), () => net.listeners.delete(l)),
  };
  return { ...real, registry: { linkOf: () => link } };
});
vi.mock("../files/store", () => ({ openFileTab: async (...a: unknown[]) => void net.opened.push(a), openMadeTab: vi.fn() }));
vi.mock("../canvas/frame", () => ({ sayError: vi.fn() }));
const { TimeoutError } = await import("../../lib/connection");
const { useFormMaking, MAKE_STAGE_WORDS } = await import("./useFormMaking");

const VIEW = { formId: "F1", title: "Untitled form", tenant: "purdue0" };
const AT = { at: "file" as const, host: "box", path: "C:\\RecWell - Documents\\Esports" };
let make!: ReturnType<typeof useFormMaking>["make"];
function Probe() {
  const m = useFormMaking({ id: "w1", environmentId: "box" });
  make = m.make;
  return <div data-testid="line">{m.stage ?? ""}</div>;
}
const push = (stage: string, op: string) => act(() => net.listeners.forEach((l) => l({ push: "work.msforms.making", workspaceId: "w1", op, stage })));
const makes = () => net.asks.filter((a) => a.method === "work.msforms.make");

afterEach(() => {
  cleanup();
  net.asks.length = 0;
  net.answers.length = 0;
  net.opened.length = 0;
  net.listeners.clear();
});

describe("New → Microsoft Form's wait", () => {
  it("says each stage the host tells, for its own press alone", async () => {
    let done!: (v: unknown) => void;
    net.answers.push(() => new Promise((r) => (done = r)));
    render(<Probe />);
    let going!: Promise<void>;
    act(() => void (going = make("microsoft", AT)));
    await waitFor(() => expect(screen.getByTestId("line").textContent).toBe(MAKE_STAGE_WORDS.asked));
    const op = makes()[0]!.params.op as string;
    expect(op).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    push("making", op);
    expect(screen.getByTestId("line").textContent).toBe("Making the form…");
    push("naming", "someone-elses-press");
    expect(screen.getByTestId("line").textContent).toBe("Making the form…");
    await act(async () => (done(VIEW), await going));
    expect(screen.getByTestId("line").textContent).toBe("");
    expect(net.opened).toHaveLength(1);
  });

  it("asks once more with the same key when the wait ran out", async () => {
    net.answers.push(() => Promise.reject(new TimeoutError("work.msforms.make", 240_000)), async () => VIEW);
    render(<Probe />);
    await act(async () => await make("microsoft", AT));
    expect(makes()).toHaveLength(2);
    expect(makes()[1]!.params.op).toBe(makes()[0]!.params.op);
    expect(net.opened).toHaveLength(1);
  });
});
