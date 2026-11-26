// @vitest-environment jsdom
/** The rules dialog keeps land first: its row has no Up, Down or Remove, and nothing moves above it. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

// "Add a step…" as a plain select, so a test picks Shell command without the lazy popup.
vi.mock("../../../components/choice-select", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../components/choice-select")>()),
  ChoiceSelect: ({ label, options, onChange }: { label: string; options: { value: string; label: string }[]; onChange: (v: string) => void }) => (
    <select aria-label={label} onChange={(e) => onChange(e.target.value)}>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  ),
}));
import { RulesDialog } from "./RulesDialog";
import type { Rules } from "./useMasterModel";

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

const rules = (steps: Rules["steps"]): Rules => ({ land: "as-they-finish", then: "notify", steps }) as Rules;
const ids = () => [...document.querySelectorAll("[data-rule-step]")].map((row) => row.getAttribute("data-rule-step"));

describe("RulesDialog", () => {
  it("draws land first with no move or remove controls, and the next row cannot move above it", () => {
    render(
      <RulesDialog
        rules={rules([
          { id: "gate", name: "Gate", kind: "gate" },
          { id: "land", name: "Land", kind: "land" },
          { id: "release", name: "Release", kind: "release" },
        ])}
        onClose={() => {}}
        onSave={async () => {}}
      />,
    );
    expect(ids()).toEqual(["land", "gate", "release"]);
    const land = document.querySelector('[data-rule-step="land"]')!;
    expect(land.querySelectorAll("button")).toHaveLength(0);
    expect((screen.getByRole("button", { name: "Move Gate up" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Move Release up" }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByRole("button", { name: "Remove Land" })).toBeNull();
  });

  it("names Then's choice in the foot's words: Notify you", () => {
    render(<RulesDialog rules={rules([{ id: "land", name: "Land", kind: "land" }])} onClose={() => {}} onSave={async () => {}} />);
    expect(screen.getByText("Notify you")).toBeTruthy();
    expect(screen.queryByText("Notify me")).toBeNull();
  });

  it("a shell step's fields are labelled Name, Folder and Command, with examples or the default as placeholders", () => {
    render(<RulesDialog rules={rules([{ id: "land", name: "Land", kind: "land" }])} onClose={() => {}} onSave={async () => {}} />);
    fireEvent.change(screen.getByLabelText("Add a step"), { target: { value: "shell" } });
    for (const name of ["Name", "Folder", "Command"]) {
      expect(screen.getByText(name).tagName).toBe("LABEL");
      expect(screen.getByLabelText(name)).toBeTruthy();
    }
    expect(screen.getByLabelText("Name").getAttribute("placeholder")).toBe("Smoke test");
    expect(screen.getByLabelText("Command").getAttribute("placeholder")).not.toMatch(/exit|,/);
    expect(screen.getByText("Passes when it exits with 0")).toBeTruthy();
  });
});
