// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { fakeDevicesLink } from "../../../../lib/devicesClient.testkit";

const { tooltipChunk, warmTooltips } = await import("@renderer/components/ui/tooltip");
const { SetupComputerView } = await import("./SetupComputerDialog");

const LINK = "https://box.example.com/setup#v1.ABCDE-FGHIJ.secret";

beforeAll(async () => {
  await tooltipChunk.load();
  warmTooltips();
});
beforeEach(() => {
  Object.defineProperty(navigator, "clipboard", { value: { writeText: vi.fn(async () => undefined) }, configurable: true });
});
afterEach(cleanup);

const checkbox = (name: string) => screen.getByRole("checkbox", { name });

describe("SetupComputerView", () => {
  it("makes a link from the name and the rows, then shows it with Copy, its end and Cancel", async () => {
    localStorage.clear();
    localStorage.setItem("monocode.colorScheme", "light");
    localStorage.setItem("monocode.defaultModels", JSON.stringify({ claude: "claude:opus" }));
    const link = fakeDevicesLink((method) => (method === "devices.setup.make" ? { link: LINK, expiresAt: Date.now() + 15 * 60_000, pairingId: "p1" } : { ok: true }));
    try {
      const onClose = vi.fn();
      render(<SetupComputerView onClose={onClose} workspaces={[{ id: "w1", name: "Purdue" }, { id: "w2", name: "Hypixel" }]} lifeosSignedIn />);
      const make = screen.getByRole("button", { name: "Make link" }) as HTMLButtonElement;
      expect(make.disabled).toBe(true);
      // Always given: ticked, and not his to untick.
      expect(checkbox("Link to the box").getAttribute("aria-checked")).toBe("true");
      expect(checkbox("Link to the box").hasAttribute("data-disabled")).toBe(true);
      fireEvent.click(checkbox("Hypixel"));
      fireEvent.change(screen.getByPlaceholderText("Purdue laptop"), { target: { value: "Purdue laptop" } });
      fireEvent.click(make);
      await waitFor(() => expect(link.methods()).toContain("devices.setup.make"));
      expect(link.calls[0].params).toEqual({
        name: "Purdue laptop",
        items: { accounts: true, lifeos: true, reader: true, folders: true },
        workspaces: ["w1"],
        // This window's theme per place and default models ride along, for the new computer's window.
        seeds: { appearance: { code: "light", work: "light" }, defaultModels: { claude: "claude:opus" } },
      });
      expect(((await screen.findByLabelText("Link")) as HTMLInputElement).value).toBe(LINK);
      expect(screen.getByRole("button", { name: "Copy link" })).toBeTruthy();
      expect(screen.getByText(/Ends in 1[45]:\d\d/)).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      await waitFor(() => expect(link.calls.at(-1)).toEqual({ method: "devices.setup.cancel", params: { pairingId: "p1" } }));
    } finally {
      link.restore();
    }
  });

  it("leaves LifeOS and its reader off while this Mac's Work is not signed in", () => {
    render(<SetupComputerView onClose={() => {}} workspaces={[]} lifeosSignedIn={false} />);
    const lifeos = checkbox("LifeOS signed in");
    expect(lifeos.getAttribute("aria-checked")).toBe("false");
    expect(checkbox("Outlook and Teams reader").getAttribute("aria-checked")).toBe("false");
    expect(checkbox("Folders in Files").getAttribute("aria-checked")).toBe("false");
  });
});
