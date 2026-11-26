// Fixtures for `bun run ui:preview src/renderer/src/components/ui/combobox.fixtures.tsx#ComboboxGallery`
// (and `#TextFieldGallery`, the field form that keeps free text):
// the closed field beside a select, and the open list drawn in place (Base
// UI's `inline` list in the popup's own box, since a static page draws no
// portal): a chosen row, the highlighted row, group headings, and no match.
// The keys and the still pointer are DOM-tested (ui.dom.test.tsx,
// choice-combobox.dom.test.tsx).
import type { ReactNode } from "react";
import { ChoiceCombobox, suggestionsFor, TextCombobox } from "../choice-combobox-body";
import { ColdSelectTrigger } from "../lazy-select";
import { Combobox, ComboboxCollection, ComboboxEmpty, ComboboxField, ComboboxFieldInput, ComboboxFieldItem, ComboboxGroup, ComboboxItem, ComboboxLabel, ComboboxList, ComboboxSearch, ComboboxSeparator } from "./combobox";

type Model = { value: string; label: string };
const MODELS: { value: string; items: Model[] }[] = [
  { value: "Claude", items: ["Fable 5.2", "Opus 5.5", "Sonnet 5.5"].map((label) => ({ value: label, label })) },
  { value: "Codex", items: ["GPT-6.2 Sol", "GPT-6.2 Astra", "GPT-5.6 Luna"].map((label) => ({ value: label, label })) },
  { value: "Muse", items: ["Muse Wonder 1.0", "Muse Spark 1.3"].map((label) => ({ value: label, label })) },
];

const OPTIONS = MODELS.flatMap((group) => group.items.map((model) => ({ ...model, group: group.value })));

function Panel({ query, children }: { query?: string; children?: ReactNode }) {
  return (
    <div className="flex w-64 flex-col rounded-xl bg-popover p-1 text-popover-foreground shadow-overlay ring-1 ring-border">
      <Combobox
        inline
        open
        items={MODELS}
        defaultValue={MODELS[0].items[1]}
        defaultInputValue={query}
        autoHighlight
        itemToStringLabel={(model: Model) => model.label}
        isItemEqualToValue={(a: Model, b: Model) => a.value === b.value}
      >
        <ComboboxSearch aria-label="Search Build model" placeholder="Search" />
        <ComboboxSeparator />
        <ComboboxEmpty>No matches</ComboboxEmpty>
        <ComboboxList>
          {(group: (typeof MODELS)[number]) => (
            <ComboboxGroup key={group.value} items={group.items}>
              <ComboboxLabel>{group.value}</ComboboxLabel>
              <ComboboxCollection>
                {(model: Model) => (
                  <ComboboxItem key={model.value} value={model}>
                    {model.label}
                  </ComboboxItem>
                )}
              </ComboboxCollection>
            </ComboboxGroup>
          )}
        </ComboboxList>
        {children}
      </Combobox>
    </div>
  );
}

function Case({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-xs font-medium text-muted-foreground">{title}</h3>
      {children}
    </section>
  );
}

export function ComboboxGallery() {
  return (
    <div className="flex flex-wrap items-start gap-6">
      <Case title="Closed, beside a select">
        <div className="flex items-center gap-2">
          <ChoiceCombobox label="Build model" value="Opus 5.5" options={OPTIONS} onChange={() => {}} className="w-44" />
          <ColdSelectTrigger onOpen={() => {}} className="w-28">
            High
          </ColdSelectTrigger>
        </div>
      </Case>
      <Case title="Open">
        <Panel />
      </Case>
      <Case title="Filtered">
        <Panel query="gpt" />
      </Case>
      <Case title="No match">
        <Panel query="zzz" />
      </Case>
    </div>
  );
}

const SELLERS = ["Office Depot", "Staples", "Amazon", "Costco"];

/** The field with its suggestions open under it, drawn in place (an `inline` list in the popup's own box), the first row highlighted as after ↓. */
function FieldOpen({ typed }: { typed: string }) {
  return (
    <ComboboxField inline open items={suggestionsFor(SELLERS, typed)} mode="none" defaultValue={typed} autoHighlight="always">
      <ComboboxFieldInput aria-label="Who" className="w-56" />
      <div className="mt-1 flex w-56 flex-col rounded-xl bg-popover p-1 text-popover-foreground shadow-overlay ring-1 ring-border">
        <ComboboxList>
          {(text: string) => (
            <ComboboxFieldItem key={text} value={text}>
              {text}
            </ComboboxFieldItem>
          )}
        </ComboboxList>
      </div>
    </ComboboxField>
  );
}

export function TextFieldGallery() {
  return (
    <div className="flex flex-wrap items-start gap-6">
      <Case title="Empty">
        <TextCombobox label="Who" value="" suggestions={SELLERS} placeholder="Who was paid" onChange={() => {}} className="w-56" />
      </Case>
      <Case title="Words no row holds">
        <TextCombobox label="Who" value="Dana's Diner" suggestions={SELLERS} onChange={() => {}} className="w-56" />
      </Case>
      <Case title="Suggesting">
        <FieldOpen typed="o" />
      </Case>
      <Case title="Small, beside a select">
        <div className="flex items-center gap-2">
          <TextCombobox label="Who" value="Staples" suggestions={SELLERS} onChange={() => {}} size="sm" className="w-40" />
          <ColdSelectTrigger onOpen={() => {}} size="sm" className="w-28">
            Supplies
          </ColdSelectTrigger>
        </div>
      </Case>
      <Case title="Invalid">
        <TextCombobox label="Who" value="" suggestions={SELLERS} placeholder="Who was paid" onChange={() => {}} className="w-56" aria-invalid />
      </Case>
      <Case title="Disabled">
        <TextCombobox label="Who" value="Costco" suggestions={SELLERS} onChange={() => {}} className="w-56" disabled />
      </Case>
    </div>
  );
}
