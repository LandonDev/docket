// @vitest-environment jsdom
/**
 * Open from Google's dialog (docs/DESIGN.md "The canvas pane"): one choice,
 * the account; with none that can open Drive files, one muted line says why,
 * with no empty select and no dead Choose files.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const answer = vi.hoisted(() => ({ accounts: { picker: true, accounts: [] as { account: string; files: boolean }[] } }));
vi.mock("../../lib/connection", () => ({ registry: { primaryEnvironmentId: "mac", onLink: () => () => undefined, linkOf: () => ({ request: async () => answer.accounts }) } }));

const { PickDialog } = await import("./PickDialog");

afterEach(cleanup);

describe("Open from Google", () => {
  it("with no account allowed Drive files, says so in one line, and offers only Cancel", async () => {
    answer.accounts = { picker: true, accounts: [{ account: "landon@example.com", files: false }] };
    render(<PickDialog env="box" sessionId="t1" onClose={() => {}} />);
    expect(await screen.findByText("No Google account has allowed Drive files yet. Reconnect one in LifeOS.")).toBeTruthy();
    expect(screen.queryByRole("combobox", { name: "Account" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Choose files" })).toBeNull();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
  });

  it("with an account, offers it and Choose files", async () => {
    answer.accounts = { picker: true, accounts: [{ account: "landon@example.com", files: true }] };
    render(<PickDialog env="box" sessionId="t1" onClose={() => {}} />);
    expect(await screen.findByRole("combobox", { name: "Account" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Choose files" }).hasAttribute("disabled")).toBe(false);
  });
});
