// bun run ui:preview src/renderer/src/components/ui/overlays.fixtures.tsx#OpenMenu --shot --fresh
// Exports OpenMenu, OpenSelect and OpenPopover. data-highlighted stands in for keyboard highlight;
// static shots show open panels in place, without placement, focus or dismissal. Every menu row has its glyph, as the app's do.
import { Eye, FileText, FolderOpen, Trash2 } from "@renderer/chrome/icons";
import { Button } from "./button";
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuShortcut, DropdownMenuTrigger } from "./dropdown-menu";
import { Kbd } from "./kbd";
import { Popover, PopoverContent, PopoverDescription, PopoverHeader, PopoverTitle, PopoverTrigger } from "./popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./select";

export function OpenMenu() {
  return (
    <DropdownMenu defaultOpen modal={false}>
      <DropdownMenuTrigger render={<Button variant="outline" />}>File actions</DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuItem data-highlighted=""><FileText />Open file<DropdownMenuShortcut><Kbd>Enter</Kbd></DropdownMenuShortcut></DropdownMenuItem>
        <DropdownMenuItem disabled><FolderOpen />Reveal in folder</DropdownMenuItem>
        <DropdownMenuCheckboxItem checked><Eye />Show hidden files</DropdownMenuCheckboxItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive"><Trash2 />Delete file…</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function OpenSelect() {
  return (
    <Select defaultOpen defaultValue="current" items={[{ value: "current", label: "Current project" }, { value: "all", label: "All projects" }]}>
      <SelectTrigger aria-label="Scope"><SelectValue /></SelectTrigger>
      <SelectContent alignItemWithTrigger={false}>
        <SelectItem value="current">Current project</SelectItem>
        <SelectItem value="all">All projects</SelectItem>
      </SelectContent>
    </Select>
  );
}

export function OpenPopover() {
  return (
    <Popover defaultOpen>
      <PopoverTrigger render={<Button variant="outline" />}>About this workspace</PopoverTrigger>
      <PopoverContent>
        <PopoverHeader>
          <PopoverTitle>Field guide</PopoverTitle>
          <PopoverDescription>Files are stored on the box.</PopoverDescription>
        </PopoverHeader>
      </PopoverContent>
    </Popover>
  );
}
