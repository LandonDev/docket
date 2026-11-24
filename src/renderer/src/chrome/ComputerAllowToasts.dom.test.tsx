// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { fakeDevicesLink } from "../lib/devicesClient.testkit";
import { loadToast } from "./toastSync";
import { ComputerAllowToasts } from "./ComputerAllowToasts";

const toast = vi.hoisted(() => Object.assign(vi.fn(), { error: vi.fn(), dismiss: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

afterEach(() => {
  cleanup();
  toast.mockClear();
  toast.dismiss.mockClear();
});

type Options = { id: string; description: string; duration: number; action: { label: string; onClick: () => void }; cancel: { label: string; onClick: () => void } };

describe("ComputerAllowToasts", () => {
  it("holds '<name> wants to join' with the three words until Allow or Remove answers it", async () => {
    const link = fakeDevicesLink((method) => (method === "devices.setup.links" ? { links: [] } : { ok: true }));
    try {
      render(<ComputerAllowToasts />);
      await act(async () => {
        link.push({ push: "device-allow", pairingId: "p1", name: "Purdue laptop", words: ["maple", "river", "seven"] });
        await loadToast();
      });
      expect(toast).toHaveBeenCalledTimes(1);
      const [title, options] = toast.mock.calls[0] as unknown as [string, Options];
      expect(title).toBe("Purdue laptop wants to join");
      expect(options).toMatchObject({ description: "maple · river · seven", duration: Infinity, action: { label: "Allow" }, cancel: { label: "Remove" } });

      await act(async () => {
        options.action.onClick();
        await loadToast();
      });
      expect(link.calls.at(-1)).toEqual({ method: "devices.setup.allow", params: { pairingId: "p1" } });
      expect(toast.dismiss).toHaveBeenCalledWith(options.id);

      await act(async () => {
        link.push({ push: "device-allow", pairingId: "p2", name: "Lab PC", words: ["oak", "lime", "four"] });
        await loadToast();
      });
      const [, second] = toast.mock.calls[1] as unknown as [string, Options];
      await act(async () => {
        second.cancel.onClick();
        await loadToast();
      });
      expect(link.calls.at(-1)).toEqual({ method: "devices.setup.deny", params: { pairingId: "p2" } });
    } finally {
      link.restore();
    }
  });

  it("shows a claim still waiting after a reload, and lets it go once another window answers it", async () => {
    const link = fakeDevicesLink((method) =>
      method === "devices.setup.links"
        ? { links: [{ pairingId: "p3", name: "Desk PC", expiresAt: 1, state: "asking", words: ["sun", "moss", "ten"] }, { pairingId: "p4", name: "Old", expiresAt: 1, state: "open" }] }
        : { ok: true },
    );
    try {
      render(<ComputerAllowToasts />);
      await act(async () => {
        await Promise.resolve();
        await loadToast();
      });
      expect(toast).toHaveBeenCalledTimes(1);
      const [title, options] = toast.mock.calls[0] as unknown as [string, Options];
      expect(title).toBe("Desk PC wants to join");
      await act(async () => {
        link.push({ push: "device-link", link: { pairingId: "p3", name: "Desk PC", expiresAt: 1, state: "allowed" } });
        await loadToast();
      });
      expect(toast.dismiss).toHaveBeenCalledWith(options.id);
    } finally {
      link.restore();
    }
  });
});
