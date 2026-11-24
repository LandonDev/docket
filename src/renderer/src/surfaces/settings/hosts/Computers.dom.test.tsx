// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ComputerRow, ComputersAnswer } from "@server/shared/contract-devices";
import { fakeDevicesLink } from "../../../lib/devicesClient.testkit";
import { ComputersBlock, ComputersGroup } from "./Computers";

const NOW = 1_800_000_000_000;
const row = (over: Partial<ComputerRow>): ComputerRow => ({
  envId: "env_pc",
  name: "Purdue laptop",
  state: "active",
  holds: [
    { service: "claude-code", account: "u1" },
    { service: "claude-code", account: "u2" },
    { service: "codex", account: "c1" },
  ],
  syncedAt: NOW - 3 * 60_000,
  paused: false,
  waitingForContact: false,
  lastError: null,
  ...over,
});
const answer = (computers: ComputerRow[]): ComputersAnswer => ({
  computers,
  giver: { keyId: "k_mac", identity: { signPublic: "s", sealPublic: "x" }, name: "Landon's MacBook", at: 1 },
  box: { envId: "env_box", name: "box", holds: [{ service: "codex", account: "c1" }], syncedAt: NOW - 60_000 },
});
const noop = () => {};

afterEach(cleanup);

describe("ComputersBlock", () => {
  it("names the giver once, gives the box no actions, and says what each computer holds and when it synced", () => {
    render(<ComputersBlock answer={answer([row({})])} error={null} giverHere onRetry={noop} onSetUp={noop} onUseLink={noop} onAct={async () => {}} now={NOW} />);
    expect(screen.getAllByText("Landon's MacBook")).toHaveLength(1);
    const box = document.querySelector<HTMLElement>("[data-computer-box]")!;
    expect(box.textContent).toContain("1 Codex");
    expect(within(box).queryAllByRole("button")).toHaveLength(0);
    const pc = document.querySelector<HTMLElement>("[data-computer='env_pc']")!;
    expect(pc.textContent).toContain("2 Claude");
    expect(pc.textContent).toContain("1 Codex");
    expect(pc.textContent).toContain("synced 3m ago");
    expect(within(pc).getByRole("button", { name: "Stop" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Set up a computer…" })).toBeTruthy();
  });

  it("offers Start on a stopped computer and nothing but the wait while one is removed", () => {
    render(
      <ComputersBlock
        answer={answer([row({ state: "stopped" }), row({ envId: "env_two", name: "Lab PC", state: "removing", waitingForContact: true })])}
        error={null}
        giverHere={false}
        onRetry={noop}
        onSetUp={noop}
        onUseLink={noop}
        onAct={async () => {}}
        now={NOW}
      />,
    );
    expect(within(document.querySelector<HTMLElement>("[data-computer='env_pc']")!).getByRole("button", { name: "Start" })).toBeTruthy();
    const gone = document.querySelector<HTMLElement>("[data-computer='env_two']")!;
    expect(gone.textContent).toContain("Waiting for Lab PC to be in touch");
    expect(within(gone).queryAllByRole("button")).toHaveLength(0);
    expect(screen.getByRole("button", { name: "Use a setup link…" })).toBeTruthy();
  });

  it("removes only once the confirm's verb is pressed", async () => {
    const onAct = vi.fn(async () => {});
    render(<ComputersBlock answer={answer([row({})])} error={null} giverHere onRetry={noop} onSetUp={noop} onUseLink={noop} onAct={onAct} now={NOW} />);
    fireEvent.click(within(document.querySelector<HTMLElement>("[data-computer='env_pc']")!).getByRole("button", { name: "Remove" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("Remove Purdue laptop")).toBeTruthy();
    expect(onAct).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(onAct).toHaveBeenCalledWith("env_pc", "remove"));
  });

  it("says a refusal under the computer's own row", async () => {
    render(
      <ComputersBlock answer={answer([row({})])} error={null} giverHere onRetry={noop} onSetUp={noop} onUseLink={noop} onAct={async () => Promise.reject(new Error("The box is not connected"))} now={NOW} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(await screen.findByText("The box is not connected")).toBeTruthy();
  });
});

describe("ComputersGroup", () => {
  it("reads devices.computers and again on a computer's push", async () => {
    const link = fakeDevicesLink((method) => (method === "devices.computers" ? answer([row({})]) : { ok: true }));
    try {
      render(<ComputersGroup saved={[{ id: "env_box", keyId: "k_mac" } as never]} onSetUp={noop} onUseLink={noop} />);
      expect(await screen.findByText("Purdue laptop")).toBeTruthy();
      // This desktop holds the giver's key: it sets computers up.
      expect(screen.getByRole("button", { name: "Set up a computer…" })).toBeTruthy();
      await act(async () => link.push({ push: "device-acked", envId: "env_pc" }));
      await waitFor(() => expect(link.methods().filter((m) => m === "devices.computers")).toHaveLength(2));
    } finally {
      link.restore();
    }
  });
});
