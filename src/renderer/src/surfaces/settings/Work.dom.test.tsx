// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NO_ANSWER } from "../../lib/connection/openRead";

const state = vi.hoisted(() => ({
  /** computers this window's key cannot switch */
  cannot: new Set<string>(),
  offline: new Set<string>(),
  on: new Set<string>(["env_box"]),
  calls: [] as { env: string; method: string; params: unknown }[],
  refuse: new Set<string>(),
  confirm: true,
  unread: new Set<string>(),
  readFails: new Set<string>(),
  /** A write held open until the test lets it go. */
  gate: null as null | Promise<void>,
  asked: [] as { title: string; body?: string; action: string }[],
}));
const ENVS = [
  { id: "env_box", name: "The box" },
  { id: "local", name: "MacBook Pro" },
  { id: "env_pc", name: "PURDUE-LT" },
];

vi.mock("@renderer/lib/sounds", async (original) => ({ ...(await original<typeof import("@renderer/lib/sounds")>()), playCue: () => {} }));
vi.mock("../../lib/connection", async (original) => {
  const real = await original<typeof import("../../lib/connection")>();
  return { ...real, useEnvironments: () => ENVS, registry: Object.assign(Object.create(real.registry), { environment: (id: string) => ENVS.find((e) => e.id === id) }) };
});
// One link a computer, as the registry keeps: a new object each render would read again each render.
const links = new Map<string, { connected: boolean; onOpen: () => () => void }>();
const linkOf = (env: string, connected: boolean) => {
  const was = links.get(env);
  if (was && was.connected === connected) return was;
  const link = { connected, onOpen: () => () => {} };
  links.set(env, link);
  return link;
};
vi.mock("./parts/hostRpc", () => ({
  useHost: (env: string) => ({
    environmentId: env,
    connected: !state.offline.has(env),
    name: { name: ENVS.find((e) => e.id === env)!.name, own: env === "local" },
    may: () => !state.cannot.has(env),
    link: linkOf(env, !state.offline.has(env)),
    request: async (method: string, params: { enabled: boolean }) => {
      // The row's own read of the switch: not a write.
      if (method === "work.get") {
        if (state.unread.has(env)) return new Promise(() => {});
        if (state.readFails.has(env)) throw new Error(NO_ANSWER);
        return { enabled: state.on.has(env) };
      }
      state.calls.push({ env, method, params });
      await state.gate;
      if (state.refuse.has(env)) throw new Error("forbidden: work.set needs admin");
      return { enabled: params.enabled };
    },
  }),
}));
vi.mock("../../lib/workSwitch", () => ({
  useWorkHosts: () => state.on,
  setWorkOn: (env: string, on: boolean) => void (on ? state.on.add(env) : state.on.delete(env)),
}));
vi.mock("../../lib/tcserver/workspaces", () => ({
  useWorkspaces: () => [
    { id: "w1", name: "Purdue Esports", kind: "work", environmentId: "env_box" },
    { id: "w2", name: "Cosmic", kind: "work", environmentId: "env_box" },
    { id: "c1", name: "temp-code", kind: "code", environmentId: "env_box" },
  ],
}));
vi.mock("../../chrome/ConfirmDialog", () => ({
  confirmAction: async (request: { title: string; body?: string; action: string }) => {
    state.asked.push(request);
    return state.confirm;
  },
}));
vi.mock("../../lib/lazyChunk", () => ({ defineChunk: () => ({ surface: () => () => null }) }));

const { WorkPage, workOffAsk } = await import("./Work");
const { useFoundRow, workOnRow } = await import("../../lib/settings/reveal");
const { requestSettings } = await import("../../lib/monaco/debugTab");
const { useState } = await import("react");

afterEach(() => {
  cleanup();
  links.clear();
  state.on = new Set(["env_box"]);
  state.cannot = new Set();
  state.offline = new Set();
  state.calls = [];
  state.refuse = new Set();
  state.confirm = true;
  state.asked = [];
  state.unread = new Set();
  state.readFails = new Set();
  state.gate = null;
});

const rowOf = (env: string): HTMLElement => document.querySelector<HTMLElement>(`[data-work-on="${env}"]`)!;
const settle = () => act(async () => void (await new Promise((done) => setTimeout(done, 0))));

describe("Settings → Work: Work is on for", () => {
  it("draws one row per computer by its one name, this Mac's with its mark, under the section the reveal lands on", async () => {
    render(<WorkPage />);
    await settle();
    expect(document.querySelector('section[data-setting="work.on"]')).toBeTruthy();
    expect(screen.getByText("Work is on for")).toBeTruthy();
    expect(rowOf("env_box").textContent).toContain("2 jobs");
    expect(rowOf("local").textContent).toContain("this Mac");
    expect(screen.getAllByRole("switch")).toHaveLength(3);
  });

  it("writes one computer per press: no handler on the page reaches a computer its row does not name", async () => {
    render(<WorkPage />);
    await settle();
    for (const env of ENVS.map((e) => e.id)) {
      const before = state.calls.length;
      await act(async () => fireEvent.click(within(rowOf(env)).getByRole("switch")));
      await settle();
      const press = state.calls.slice(before);
      expect(press, env).toEqual([{ env, method: "work.set", params: { enabled: env !== "env_box" } }]);
    }
    // Every control the page draws, pressed once more: never two computers at one press.
    for (const control of [...screen.getAllByRole("switch"), ...screen.queryAllByRole("button")]) {
      const before = state.calls.length;
      await act(async () => fireEvent.click(control));
      await settle();
      expect(new Set(state.calls.slice(before).map((c) => c.env)).size).toBeLessThanOrEqual(1);
    }
  });

  it("asks before turning Work off, naming what leaves the list, and writes nothing on Cancel", async () => {
    state.confirm = false;
    render(<WorkPage />);
    await settle();
    await act(async () => fireEvent.click(within(rowOf("env_box")).getByRole("switch")));
    await settle();
    expect(state.asked).toEqual([workOffAsk("the box", 2)]);
    expect(state.asked[0]!.body).toBe("The Outbox, Work Chats and 2 jobs leave the list on every device. Nothing is deleted, and turning it on brings them back.");
    expect(state.calls).toEqual([]);
    expect(within(rowOf("env_box")).getByRole("switch").getAttribute("aria-checked")).toBe("true");
  });

  it("turns Work on without asking", async () => {
    render(<WorkPage />);
    await settle();
    await act(async () => fireEvent.click(within(rowOf("local")).getByRole("switch")));
    await settle();
    expect(state.asked).toEqual([]);
    expect(state.on.has("local")).toBe(true);
  });

  it("shows a computer this key may not switch as its state in words and who can, with no switch to refuse", async () => {
    state.cannot = new Set(["env_pc"]);
    state.on = new Set(["env_box", "env_pc"]);
    render(<WorkPage />);
    await settle();
    const row = rowOf("env_pc");
    expect(within(row).queryByRole("switch")).toBeNull();
    expect(row.textContent).toContain("Changed from a computer that manages PURDUE-LT");
    expect(row.textContent).toContain("On");
    expect(row.textContent).not.toContain("this Mac or");
  });

  it("holds a computer's switch as a bone until it says whether Work is on, and a failed read is its line with Retry", async () => {
    state.unread = new Set(["env_box"]);
    state.readFails = new Set(["env_pc"]);
    render(<WorkPage />);
    await settle();
    expect(within(rowOf("env_box")).queryByRole("switch")).toBeNull();
    expect(rowOf("env_box").querySelector("[data-region][data-bones] [skullet-loading] [role=switch]")).toBeTruthy();
    // A computer whose read failed draws no bare row: the failure says it.
    expect(rowOf("env_pc")).toBeNull();
    // A failed read is one line over the rows with one Retry, never one a row.
    expect(screen.getAllByRole("button", { name: "Retry" })).toHaveLength(1);
    expect(screen.getByRole("alert").textContent).toBe("PURDUE-LT did not answer.");
    expect(within(rowOf("local")).getByRole("switch")).toBeTruthy();
  });

  it("refuses a second flip at once while its write is out, keeps the pending flip shown, and draws it held only once the hold lasts 150 ms", async () => {
    render(<WorkPage />);
    await settle();
    let let_go!: () => void;
    state.gate = new Promise<void>((done) => (let_go = done));
    const flip = () => within(rowOf("local")).getByRole("switch");
    await act(async () => fireEvent.click(flip()));
    // At once: the flip shows and nothing is drawn disabled; a second press sends nothing and the flip stays.
    expect(flip().getAttribute("aria-checked")).toBe("true");
    expect(flip().hasAttribute("disabled") || flip().hasAttribute("data-disabled")).toBe(false);
    await act(async () => fireEvent.click(flip()));
    expect(flip().getAttribute("aria-checked")).toBe("true");
    expect(state.calls).toEqual([{ env: "local", method: "work.set", params: { enabled: true } }]);
    await act(async () => void (await new Promise((done) => setTimeout(done, 170))));
    expect(flip().hasAttribute("disabled") || flip().hasAttribute("data-disabled")).toBe(true);
    await act(async () => {
      let_go();
      await state.gate;
    });
    await settle();
    expect(flip().getAttribute("aria-checked")).toBe("true");
    expect(flip().hasAttribute("data-disabled")).toBe(false);
  });

  it("keeps the pending flip shown when a push moves the switch while its write is out, then shows what the write answered", async () => {
    const { rerender } = render(<WorkPage />);
    await settle();
    let let_go!: () => void;
    state.gate = new Promise<void>((done) => (let_go = done));
    const flip = () => within(rowOf("local")).getByRole("switch");
    await act(async () => fireEvent.click(flip()));
    // A push (another window, the phone) says Work is off there while this write is out: the press's flip stands.
    state.on = new Set(["env_box"]);
    rerender(<WorkPage />);
    expect(flip().getAttribute("aria-checked")).toBe("true");
    await act(async () => {
      let_go();
      await state.gate;
    });
    await settle();
    rerender(<WorkPage />);
    expect(flip().getAttribute("aria-checked")).toBe("true");
    expect(state.on.has("local")).toBe(true);
  });

  it("says an offline computer is offline, with no switch", async () => {
    state.offline = new Set(["env_pc"]);
    render(<WorkPage />);
    await settle();
    expect(within(rowOf("env_pc")).queryByRole("switch")).toBeNull();
    expect(rowOf("env_pc").textContent).toContain("Offline");
  });

  it("puts a refused switch back and says why under its row, in the house's words", async () => {
    state.refuse = new Set(["local"]);
    render(<WorkPage />);
    await settle();
    await act(async () => fireEvent.click(within(rowOf("local")).getByRole("switch")));
    await settle();
    expect(within(rowOf("local")).getByRole("switch").getAttribute("aria-checked")).toBe("false");
    expect(rowOf("local").textContent).toContain("This computer's key may not do that on MacBook Pro. Do it from a computer that manages MacBook Pro.");
    expect(rowOf("local").textContent?.toLowerCase()).not.toContain("forbidden");
    expect(state.calls).toEqual([{ env: "local", method: "work.set", params: { enabled: true } }]);
  });
});

describe("the way in from a computer's page", () => {
  it("lands on that computer's own row of Work is on for", async () => {
    Element.prototype.scrollIntoView ??= () => {};
    function Revealed() {
      const [root, setRoot] = useState<HTMLElement | null>(null);
      useFoundRow(root, "work");
      return (
        <div ref={setRoot}>
          <WorkPage />
        </div>
      );
    }
    requestSettings("work", workOnRow("env_pc"));
    render(<Revealed />);
    await settle();
    expect(rowOf("env_pc").hasAttribute("data-found")).toBe(true);
    expect(rowOf("env_box").hasAttribute("data-found")).toBe(false);
  });
});
