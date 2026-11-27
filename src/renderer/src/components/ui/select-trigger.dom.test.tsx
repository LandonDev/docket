// @vitest-environment jsdom
/**
 * A value too long for its trigger ends in "…" (select-trigger.ts): the value slot truncates and may shrink, where
 * `line-clamp-1` with `flex` cut a glyph in half. jsdom lays nothing out, so this holds the classes that do it on every
 * trigger built on `SELECT_TRIGGER`; the pictures are select-trigger.preview.tsx#TriggerCuts.
 */
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ColdSelectTrigger } from "../lazy-select";
import { Combobox, ComboboxTrigger } from "./combobox";
import { DateField } from "./date-field";
import { Select, SelectTrigger, SelectValue } from "./select";
import { SELECT_TRIGGER, SELECT_VALUE } from "./select-trigger";

afterEach(cleanup);

const classes = (el: Element | null) => (el?.getAttribute("class") ?? "").split(/\s+/);

describe("the select trigger's value", () => {
  it("truncates with an ellipsis and may shrink; it lays out in a row only when it holds a glyph", () => {
    const trigger = SELECT_TRIGGER.split(/\s+/);
    expect(trigger).toEqual(expect.arrayContaining(["*:data-[slot=select-value]:min-w-0", "*:data-[slot=select-value]:truncate", "*:data-[slot=select-value]:has-[>*]:flex"]));
    expect(trigger.some((c) => c.includes("line-clamp"))).toBe(false);
    expect(trigger).not.toContain("*:data-[slot=select-value]:flex");
    expect(SELECT_VALUE.split(/\s+/)).not.toContain("flex");
  });

  it.each([
    ["Select", () => (
      <Select defaultValue="a" items={[{ value: "a", label: "Every project in this workspace and its copies" }]}>
        <SelectTrigger aria-label="Scope">
          <SelectValue />
        </SelectTrigger>
      </Select>
    )],
    ["the cold trigger", () => <ColdSelectTrigger onOpen={() => {}}>Every project in this workspace</ColdSelectTrigger>],
    ["DateField", () => <DateField aria-label="Due" value="2026-11-26" onChange={() => {}} />],
    ["Combobox", () => (
      <Combobox items={["Claude Opus 5.5 with the long context window"]}>
        <ComboboxTrigger aria-label="Model">Claude Opus 5.5 with the long context window</ComboboxTrigger>
      </Combobox>
    )],
  ])("%s draws its value in the slot the trigger cuts", (_name, ui) => {
    const { container } = render(ui());
    const slot = container.querySelector("[data-slot=select-value]");
    expect(slot).not.toBeNull();
    expect(slot!.parentElement!.className.split(/\s+/)).toContain("*:data-[slot=select-value]:truncate");
    expect(classes(slot)).toContain("flex-1");
    expect(classes(slot)).not.toContain("flex");
  });
});
