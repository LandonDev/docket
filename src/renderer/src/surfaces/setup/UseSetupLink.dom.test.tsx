// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { SetupPeek, SetupState } from "@server/shared/contract-devices";
import { fakeDevicesLink } from "../../lib/devicesClient.testkit";
import { UseSetupLinkDialog } from "./UseSetupLink";
import { SETUP_SEEDED_KEY } from "./setupFlow";

const pickFolders = vi.hoisted(() => vi.fn(async () => ["C:\\Users\\landon\\Purdue"]));
vi.mock("../../lib/fs", () => ({ pickFolders }));

const LINK = "https://box.example.com/setup#v1.ABCDE-FGHIJ.secret";
const items = { accounts: true, lifeos: false, reader: false, folders: true };
const peek: SetupPeek = { giver: "Landon's MacBook", origin: "https://box.example.com", items, expiresAt: Date.now() + 600_000 };
// The host lists only the steps the link gives.
const started: SetupState = {
  giver: peek.giver,
  origin: peek.origin,
  steps: [
    { step: "link", state: "done" },
    { step: "allow", state: "working" },
    { step: "accounts", state: "waiting" },
    { step: "folders", state: "waiting" },
  ],
  words: null,
  seeds: { appearance: { code: "light" }, defaultModels: { claude: "claude:opus" } },
  done: false,
};

beforeEach(() => localStorage.clear());
afterEach(cleanup);

const step = (name: string) => document.querySelector<HTMLElement>(`[data-setup-step='${name}']`)!;

describe("UseSetupLinkDialog", () => {
  it("goes from the paste through who gives what to the steps, a failed step's Retry, and Ready", async () => {
    let state = started;
    const link = fakeDevicesLink((method) => {
      if (method === "devices.setup.peek") return peek;
      if (method === "devices.setup.state") return state;
      return { ok: true };
    });
    try {
      render(<UseSetupLinkDialog first onClose={() => {}} />);
      expect(screen.getByRole("button", { name: "Skip" })).toBeTruthy();
      fireEvent.change(screen.getByLabelText("Paste the link from your Mac"), { target: { value: ` ${LINK} ` } });
      fireEvent.click(screen.getByRole("button", { name: "Continue" }));

      // Nothing moves before the press: only the peek went.
      const gives = await screen.findByText((_, el) => el?.hasAttribute("data-setup-gives") ?? false);
      expect(gives.textContent).toBe("From Landon's MacBook at box.example.com: link to the box, your accounts, folders in Files");
      expect(link.methods()).toEqual(["devices.setup.peek"]);
      expect(link.calls[0].params).toEqual({ link: LINK });

      fireEvent.click(screen.getByRole("button", { name: "Set up this Mac" }));
      await waitFor(() => expect(step("allow")).toBeTruthy());
      expect(link.calls.find((c) => c.method === "devices.setup.start")?.params).toEqual({ link: LINK });
      expect(step("lifeos")).toBeNull();
      // The words arrive with the claim, on the Allow step's push.
      await act(async () => link.push({ push: "device-setup", step: "allow", state: "waiting", words: ["maple", "river", "seven"] }));
      expect(step("allow").textContent).toContain("maple · river · seven");
      expect(step("accounts").dataset.state).toBe("waiting");
      // Nothing to show the folders in until the giver allows this computer.
      expect(within(step("folders")).queryByRole("button", { name: "Add folders…" })).toBeNull();
      // The seeds landed once.
      expect(localStorage.getItem("monocode.colorScheme")).toBe("light");
      expect(JSON.parse(localStorage.getItem("monocode.defaultModels")!)).toEqual({ claude: "claude:opus" });
      expect(localStorage.getItem(SETUP_SEEDED_KEY)).toBe("1");

      await act(async () => {
        link.push({ push: "device-setup", step: "allow", state: "done" });
        link.push({ push: "device-setup", step: "accounts", state: "failed", reason: "The box did not answer" });
      });
      expect(step("allow").textContent).not.toContain("maple");
      expect(step("accounts").textContent).toContain("The box did not answer");
      state = {
        ...state,
        words: ["maple", "river", "seven"],
        steps: [
          { step: "link", state: "done" },
          { step: "allow", state: "done" },
          { step: "accounts", state: "working" },
          { step: "folders", state: "waiting" },
        ],
      };
      fireEvent.click(within(step("accounts")).getByRole("button", { name: "Retry" }));
      await waitFor(() => expect(link.calls.some((c) => c.method === "devices.setup.retry" && (c.params as { step: string }).step === "accounts")).toBe(true));
      await waitFor(() => expect(step("accounts").dataset.state).toBe("working"));

      // Folders waits on his pick: the native picker, then the paths to the host.
      fireEvent.click(within(step("folders")).getByRole("button", { name: "Add folders…" }));
      await waitFor(() => expect(link.calls.find((c) => c.method === "devices.setup.folders")?.params).toEqual({ paths: ["C:\\Users\\landon\\Purdue"] }));

      await act(async () => {
        link.push({ push: "device-setup", step: "accounts", state: "done" });
        link.push({ push: "device-setup", step: "folders", state: "done" });
      });
      expect(await screen.findByText("Ready")).toBeTruthy();
      expect(screen.getByText("This Mac has everything Landon's MacBook gave it.")).toBeTruthy();
    } finally {
      link.restore();
    }
  });

  it("says why a link was refused under the field", async () => {
    const link = fakeDevicesLink(() => new Error("This link was used at 3:04 PM"));
    try {
      render(<UseSetupLinkDialog onClose={() => {}} />);
      expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
      fireEvent.change(screen.getByLabelText("Paste the link from your Mac"), { target: { value: LINK } });
      fireEvent.click(screen.getByRole("button", { name: "Continue" }));
      expect(await screen.findByText("This link was used at 3:04 PM")).toBeTruthy();
    } finally {
      link.restore();
    }
  });

  it("never writes the seeds over a window that already has them", async () => {
    localStorage.setItem(SETUP_SEEDED_KEY, "1");
    localStorage.setItem("monocode.colorScheme", "dark");
    const link = fakeDevicesLink(() => ({ ok: true }));
    try {
      render(<UseSetupLinkDialog onClose={() => {}} phase={{ at: "steps", state: started }} />);
      await waitFor(() => expect(step("link")).toBeTruthy());
      expect(localStorage.getItem("monocode.colorScheme")).toBe("dark");
    } finally {
      link.restore();
    }
  });
});
