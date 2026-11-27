// bun run ui:preview src/renderer/src/components/ui/select-trigger.preview.tsx#TriggerCuts --shot --fresh
import { AccessValue } from "@renderer/chrome/AccessPicker";
import { ThreadTypeValue } from "@renderer/chrome/ThreadTypeChip";
import { ChoiceCombobox } from "../choice-combobox";
import { ColdSelectTrigger } from "../lazy-select";
import { DateField } from "./date-field";
import { Select, SelectTrigger, SelectValue } from "./select";

const LONG = [{ value: "long", label: "Every project in this workspace and its copies" }];
const MODELS = [{ value: "Opus 5.5", label: "Claude Opus 5.5 with the long context window" }];

/** Every trigger built on `SELECT_TRIGGER`, each narrower than its value (the cut ends in "…") beside one that fits,
 *  and the two composer triggers that lead with a glyph. */
export function TriggerCuts() {
  return (
    <div className="flex flex-col items-start gap-3 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <Select defaultValue="long" items={LONG}>
          <SelectTrigger aria-label="Scope" className="w-44">
            <SelectValue />
          </SelectTrigger>
        </Select>
        <Select defaultValue="long" items={LONG}>
          <SelectTrigger aria-label="Scope" size="sm">
            <SelectValue />
          </SelectTrigger>
        </Select>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <ColdSelectTrigger size="sm" onOpen={() => {}} className="w-36">
          Every project in this workspace
        </ColdSelectTrigger>
        <ColdSelectTrigger size="sm" onOpen={() => {}}>
          High
        </ColdSelectTrigger>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <ChoiceCombobox label="Build model" value="Opus 5.5" options={MODELS} onChange={() => {}} className="w-44" />
        <ChoiceCombobox label="Build model" value="Opus 5.5" options={MODELS} onChange={() => {}} />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <DateField aria-label="Due" value="2026-11-26" onChange={() => {}} className="w-32" />
        <DateField aria-label="Due" value="2026-11-26" onChange={() => {}} className="w-56" />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Select defaultValue="auto">
          <SelectTrigger aria-label="Permission mode" size="sm">
            <SelectValue>
              <AccessValue value="auto" />
            </SelectValue>
          </SelectTrigger>
        </Select>
        <Select defaultValue="plan">
          <SelectTrigger aria-label="Thread type" size="sm">
            <SelectValue>
              <ThreadTypeValue value="planning" />
            </SelectValue>
          </SelectTrigger>
        </Select>
      </div>
    </div>
  );
}
