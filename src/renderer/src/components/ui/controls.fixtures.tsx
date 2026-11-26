// bun run ui:preview src/renderer/src/components/ui/controls.fixtures.tsx#ControlsGallery --shot --fresh
// Export ControlsGallery. Static shots use data-pressed and aria-expanded for held controls.
// The focus outline stands in for keyboard focus. Pointer hover and keyboard navigation need a live page.
import { FileText, Search, StickyNote } from "@renderer/chrome/icons";
import { ChoiceToggle } from "../choice-toggle";
import { ColdSelectTrigger } from "../lazy-select";
import { BusyLabel, Button } from "./button";
import { Checkbox } from "./checkbox";
import { GroupInput, Input, InputGroup } from "./input";
import { Switch } from "./switch";
import { Tabs, TabsList, TabsTrigger } from "./tabs";
import { Textarea } from "./textarea";
import { Toggle } from "./toggle";
import { ToggleGroup, ToggleGroupItem } from "./toggle-group";

const choices = [{ value: "local", label: "Local" }, { value: "remote", label: "Remote" }] as const;
const noop = () => {};

export function ControlsGallery() {
  return (
    <div className="grid gap-4 md:grid-cols-3">
      {(["bg-background", "bg-card", "bg-sidebar"] as const).map((surface, index) => (
        <section key={surface} className={`flex min-w-0 flex-col gap-3 p-3 ${surface}`}>
          <h2 className="text-xs font-medium text-muted-foreground">{["Background", "Card", "Sidebar"][index]}</h2>
          <Input aria-label="Name" placeholder="Name" />
          <Input aria-label="Focused name" defaultValue="Field guide" className="outline outline-offset-[-1px] outline-ring" />
          <Input aria-label="Invalid name" defaultValue="Field guide" aria-invalid />
          <Input aria-label="Locked name" defaultValue="Field guide" readOnly />
          <Input aria-label="Disabled name" placeholder="Name" disabled />
          <InputGroup leading={<Search />}><GroupInput aria-label="Search files" placeholder="Search files" /></InputGroup>
          <Textarea aria-label="Notes" placeholder="Add a note" />
          <div className="flex flex-wrap items-center gap-3">
            <Checkbox aria-label="Keep copy" />
            <Checkbox aria-label="Keep copy checked" defaultChecked />
            <Checkbox aria-label="Keep copy unavailable" checked disabled />
            <Switch aria-label="Show notes" />
            <Switch aria-label="Show notes on" defaultChecked />
            <Switch aria-label="Show notes unavailable" checked disabled />
          </div>
          <div className="flex flex-wrap gap-2">
            <Toggle variant="outline" aria-label="Bold" defaultPressed><FileText /></Toggle>
            <Toggle variant="outline" aria-label="Italic" disabled><StickyNote /></Toggle>
            <ToggleGroup aria-label="Format" spacing={0} defaultValue={["bold"]} variant="outline">
              <ToggleGroupItem value="bold" aria-label="Bold"><FileText /></ToggleGroupItem>
              <ToggleGroupItem value="italic" aria-label="Italic"><StickyNote /></ToggleGroupItem>
            </ToggleGroup>
          </div>
          {(["default", "line"] as const).map((variant) => (
            <Tabs key={variant} defaultValue="files">
              <TabsList variant={variant}>
                <TabsTrigger value="files">Files</TabsTrigger>
                <TabsTrigger value="notes">Notes</TabsTrigger>
              </TabsList>
            </Tabs>
          ))}
          <div><ChoiceToggle label="Location" value="local" options={choices} onChange={noop} /></div>
          <div><ColdSelectTrigger aria-label="Project" aria-expanded data-pressed="" onOpen={noop}>Field guide</ColdSelectTrigger></div>
          <div><Button disabled><BusyLabel busy label="Save" busyLabel="Saving…" /></Button></div>
        </section>
      ))}
    </div>
  );
}
