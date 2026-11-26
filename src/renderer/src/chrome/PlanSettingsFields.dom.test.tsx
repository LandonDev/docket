// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_PLAN_SETTINGS } from "@shared/plans";

const plans = vi.hoisted(() => ({
  scope: null as null | { settings: unknown; overridden: boolean },
  failure: null as null | { error: string; retry: () => void },
  save: vi.fn(async (..._args: unknown[]) => {}),
}));
vi.mock("../lib/connection", () => ({ registry: { primary: () => ({ environmentId: "local" }) } }));
vi.mock("../lib/tcserver/plans", () => ({
  usePlanSettings: () => plans.scope,
  usePlanSettingsError: () => plans.failure,
  savePlanSettings: (...args: unknown[]) => plans.save(...args),
}));
vi.mock("../lib/sounds", () => ({ playCue: () => {} }));
vi.mock("../lib/models", () => ({ allModels: () => [], findModel: () => ({ name: "Opus 5.5" }), nativeModelId: (m: { id: string }) => m.id }));
vi.mock("../components/choice-select", async () => await import("../components/choice-select-body"));
vi.mock("../components/choice-combobox", async () => await import("../components/choice-combobox-body"));

const { PlanSettingsEditor } = await import("./PlanSettingsFields");

afterEach(cleanup);

describe("Builds from plans", () => {
  it("holds its rows in their shape until the set loads", () => {
    plans.scope = null;
    render(<PlanSettingsEditor />);
    expect(screen.getByRole("region", { name: "Builds from plans" }).querySelectorAll("[data-slot=page-row-skeleton]")).toHaveLength(5);
  });

  it("says why the set did not load, with Retry at the error's end, and no rows forever", () => {
    plans.scope = null;
    const retry = vi.fn();
    plans.failure = { error: "not connected", retry };
    render(<PlanSettingsEditor />);
    const section = screen.getByRole("region", { name: "Builds from plans" });
    expect(section.querySelectorAll("[data-slot=page-row-skeleton]")).toHaveLength(0);
    expect(screen.getByText("not connected").className).toContain("text-destructive");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(retry).toHaveBeenCalled();
    plans.failure = null;
  });

  it("draws the loaded set's rows by their new names, the model a searchable list", () => {
    plans.scope = { settings: DEFAULT_PLAN_SETTINGS, overridden: false };
    render(<PlanSettingsEditor />);
    expect(screen.getByRole("switch", { name: "Start the build when a plan is done" })).toBeTruthy();
    expect(screen.getByRole("switch", { name: "Archive the plan's thread once the build starts" })).toBeTruthy();
    expect(document.querySelector("[data-slot=combobox-trigger][aria-label='Build model']")).toBeTruthy();
    for (const name of ["Build effort", "Build context"]) expect(screen.getByRole("combobox", { name })).toBeTruthy();
  });

  it("saves a flip at once with its mark, and slides it back on a refusal with the reason under the row", async () => {
    plans.scope = { settings: { ...DEFAULT_PLAN_SETTINGS, autoImplement: true }, overridden: false };
    render(<PlanSettingsEditor />);
    const flip = screen.getByRole("switch", { name: "Start the build when a plan is done" });
    await act(async () => {
      fireEvent.click(flip);
    });
    expect(plans.save).toHaveBeenCalledWith("local", null, expect.objectContaining({ autoImplement: false }));
    expect((document.querySelector("[data-setting='plans.start']") as HTMLElement).textContent).toContain("Saved");
    plans.save.mockImplementationOnce(async () => {
      throw new Error("refused: plan settings live on box; it is offline");
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("switch", { name: "Archive the plan's thread once the build starts" }));
    });
    const row = document.querySelector("[data-setting='plans.archive']") as HTMLElement;
    expect(row.textContent).toContain("Plan settings live on box; it is offline");
    expect(screen.getByRole("switch", { name: "Archive the plan's thread once the build starts" }).getAttribute("aria-checked")).toBe(String(DEFAULT_PLAN_SETTINGS.archiveAfterStart));
  });
});
