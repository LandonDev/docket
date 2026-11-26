// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { registry } from "../../lib/connection";
import { resetLifeos, setLifeosStatus } from "../shell/lifeos";
import { PickDialog } from "./PickDialog";
import { UploadGoogleDialog } from "./UploadGoogleDialog";

afterEach(() => {
  cleanup();
  resetLifeos();
  vi.restoreAllMocks();
});

it("shows LifeOS's state in both Google dialogs and reads accounts when it returns", async () => {
  vi.spyOn(registry, "primaryEnvironmentId", "get").mockReturnValue("box");
  vi.spyOn(registry, "environment").mockReturnValue({ name: "The box" } as never);
  const request = vi.fn(async () => ({ accounts: [{ account: "proof@example.test", files: true }], picker: true }));
  vi.spyOn(registry, "linkOf").mockReturnValue({ request } as never);
  for (const dialog of [
    <PickDialog env="box" sessionId="thread" onClose={() => {}} />,
    <UploadGoogleDialog env="box" itemId="sheet" kind="Sheets" onClose={() => {}} />,
  ]) {
    setLifeosStatus("box", { lifeos: { state: "signed-out" }, keys: [] });
    const shown = render(dialog);
    expect(screen.getByText("Not signed in to LifeOS on the box")).toBeTruthy();
    expect(screen.queryByText(/^No Google account/)).toBeNull();
    expect(request).not.toHaveBeenCalled();
    await act(async () => setLifeosStatus("box", { lifeos: { state: "connected", ownerId: "owner", since: 1 }, keys: [] }));
    expect(request).toHaveBeenCalledWith("work.google.accounts", {});
    expect(await screen.findByText("proof@example.test")).toBeTruthy();
    shown.unmount();
    request.mockClear();
  }
});
