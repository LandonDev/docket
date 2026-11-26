import type { ReactNode } from "react";
import { Autocomplete as AutocompletePrimitive } from "@base-ui/react/autocomplete";
import { Combobox as ComboboxPrimitive } from "@base-ui/react/combobox";
import { Check, ChevronDown, Search } from "@renderer/chrome/icons";
import { cn } from "@renderer/lib/cn";
import { fullScreenHome } from "@renderer/lib/fullScreenHome";
import { GroupInput, Input, InputGroup } from "./input";
import { MENU_ROW } from "./menu-row";
import { SELECT_CHEVRON, SELECT_TRIGGER, SELECT_VALUE } from "./select-trigger";

/**
 * The one option picker with a field that filters: a long list (models by
 * provider, branches, workspaces). The field is the combobox, so ↑↓ move
 * `aria-activedescendant` and a reader hears the row; the pointer takes the
 * highlight only when it moves, so a row that slides under a still pointer
 * never takes it from the keyboard. Lives in the select and menu chunks,
 * never the first paint. A short list with no search is `Select`.
 *
 * The field form (`ComboboxField`, `ComboboxFieldInput`, `ComboboxFieldItem`)
 * keeps free text: the input itself is the combobox, its text is the value,
 * and the popup under it only suggests (Base UI's Autocomplete, which shares
 * the combobox's popup and list). Nothing is forced: a row taken fills the
 * field, and words no row holds stay as typed.
 */
const Combobox = ComboboxPrimitive.Root;

function ComboboxValue({ ...props }: ComboboxPrimitive.Value.Props) {
  return <ComboboxPrimitive.Value data-slot="combobox-value" {...props} />;
}

/** The closed field: the select trigger's box, value slot and still chevron. */
function ComboboxTrigger({ className, size = "default", children, ...props }: ComboboxPrimitive.Trigger.Props & { size?: "sm" | "default" }) {
  return (
    <ComboboxPrimitive.Trigger data-slot="combobox-trigger" data-size={size} className={cn(SELECT_TRIGGER, className)} {...props}>
      <span data-slot="select-value" className={SELECT_VALUE}>
        {children}
      </span>
      <ChevronDown aria-hidden className={SELECT_CHEVRON} />
    </ComboboxPrimitive.Trigger>
  );
}

/** The popup, on the popover's layer and motion. It holds the search field and the list. */
function ComboboxContent({
  className,
  side = "bottom",
  sideOffset = 4,
  align = "start",
  alignOffset = 0,
  anchor,
  ...props
}: ComboboxPrimitive.Popup.Props & Pick<ComboboxPrimitive.Positioner.Props, "side" | "align" | "sideOffset" | "alignOffset" | "anchor">) {
  return (
    <ComboboxPrimitive.Portal container={fullScreenHome()}>
      <ComboboxPrimitive.Positioner side={side} sideOffset={sideOffset} align={align} alignOffset={alignOffset} anchor={anchor} className="isolate z-(--layer-popover)">
        <ComboboxPrimitive.Popup
          data-slot="combobox-content"
          className={cn(
            "flex max-h-[min(22rem,var(--available-height))] w-(--anchor-width) min-w-56 max-w-(--available-width) origin-(--transform-origin) flex-col rounded-xl bg-popover p-1 text-popover-foreground shadow-overlay ring-1 ring-border outline-none transition-[opacity,scale] duration-(--dur-base) ease-(--ease-out) starting:opacity-0 starting:scale-95 data-ending-style:opacity-0 data-ending-style:scale-[0.98] data-ending-style:duration-(--dur-fast) data-ending-style:ease-(--ease-exit) motion-reduce:transition-opacity",
            className,
          )}
          {...props}
        />
      </ComboboxPrimitive.Positioner>
    </ComboboxPrimitive.Portal>
  );
}

/** The field that filters, in the picker's shape: the Search glyph in a
 *  row's 16px slot, no border of its own inside the popup. */
function ComboboxSearch({ className, trailing, ...props }: ComboboxPrimitive.Input.Props & { trailing?: ReactNode }) {
  return (
    <InputGroup
      leading={
        <span className="grid size-4 place-items-center">
          <Search className="size-3.5" />
        </span>
      }
      trailing={trailing}
      className={cn("shrink-0 rounded-lg border-transparent pl-[11px]", className)}
    >
      <ComboboxPrimitive.Input data-slot="combobox-search" spellCheck={false} autoComplete="off" autoCorrect="off" autoCapitalize="off" render={<GroupInput />} {...props} />
    </InputGroup>
  );
}

/** The list on a native scroller (docs/DESIGN.md "Scrolling"). */
function ComboboxList({ className, ...props }: ComboboxPrimitive.List.Props) {
  return (
    <ComboboxPrimitive.List
      data-slot="combobox-list"
      className={cn("min-h-0 flex-1 scroll-py-1 overflow-x-hidden overflow-y-auto overscroll-contain outline-none [--scrollbar-inset:var(--radius-lg)]", className)}
      {...props}
    />
  );
}

/** The field form's root: the input's text is its value (`value`, `onValueChange`), the items are suggestions. */
const ComboboxField = AutocompletePrimitive.Root;

/** The field form's input: the one text field (`Input`), which is the combobox itself. `size="sm"` is the 28px row. */
function ComboboxFieldInput({ className, size = "default", ...props }: Omit<ComboboxPrimitive.Input.Props, "size"> & { size?: "sm" | "default" }) {
  return (
    <AutocompletePrimitive.Input
      data-slot="combobox-field"
      data-size={size}
      spellCheck={false}
      autoComplete="off"
      autoCorrect="off"
      render={<Input className={cn(size === "sm" && "h-7 rounded-md", className)} />}
      {...props}
    />
  );
}

const ITEM_ROW =
  "relative flex w-full cursor-default select-none items-center rounded-lg leading-5 outline-hidden data-highlighted:bg-muted data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3.5";

/** A suggestion under the field form: a menu row's box, the highlighted one the `muted` fill, no check (nothing is chosen). */
function ComboboxFieldItem({ className, ...props }: AutocompletePrimitive.Item.Props) {
  return <AutocompletePrimitive.Item data-slot="combobox-item" className={cn(MENU_ROW, ITEM_ROW, className)} {...props} />;
}

/** A row in a menu row's box; the highlighted row is the `muted` fill, the chosen one a still check at its end.
 *  `indicator={false}` for a row that ends in controls of its own and draws its check among them. */
function ComboboxItem({ className, children, indicator = true, ...props }: ComboboxPrimitive.Item.Props & { indicator?: boolean }) {
  return (
    <ComboboxPrimitive.Item
      data-slot="combobox-item"
      className={cn(
        MENU_ROW,
        ITEM_ROW,
        indicator && "pe-8",
        className,
      )}
      {...props}
    >
      {children}
      {indicator ? (
        <ComboboxPrimitive.ItemIndicator render={<span className="pointer-events-none absolute end-2 flex size-4 items-center justify-center" />}>
          <Check className="pointer-events-none" />
        </ComboboxPrimitive.ItemIndicator>
      ) : null}
    </ComboboxPrimitive.Item>
  );
}

function ComboboxGroup({ className, ...props }: ComboboxPrimitive.Group.Props) {
  // 4px more between groups than between rows, so a heading reads with the rows under it.
  return <ComboboxPrimitive.Group data-slot="combobox-group" className={cn("[&+&]:mt-1", className)} {...props} />;
}

function ComboboxLabel({ className, ...props }: ComboboxPrimitive.GroupLabel.Props) {
  return <ComboboxPrimitive.GroupLabel data-slot="combobox-label" className={cn("px-3 py-1 text-[11px] font-medium text-muted-foreground", className)} {...props} />;
}

function ComboboxCollection({ ...props }: ComboboxPrimitive.Collection.Props) {
  return <ComboboxPrimitive.Collection data-slot="combobox-collection" {...props} />;
}

/** No match: one muted row in a row's box, never an empty state. */
function ComboboxEmpty({ className, ...props }: ComboboxPrimitive.Empty.Props) {
  return <ComboboxPrimitive.Empty data-slot="combobox-empty" className={cn("flex h-7 items-center px-3 text-[13px] text-muted-foreground empty:hidden", className)} {...props} />;
}

function ComboboxSeparator({ className, ...props }: ComboboxPrimitive.Separator.Props) {
  return <ComboboxPrimitive.Separator data-slot="combobox-separator" className={cn("pointer-events-none -mx-1 my-1 h-px shrink-0 bg-border", className)} {...props} />;
}

export {
  Combobox,
  ComboboxCollection,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxField,
  ComboboxFieldInput,
  ComboboxFieldItem,
  ComboboxGroup,
  ComboboxItem,
  ComboboxLabel,
  ComboboxList,
  ComboboxSearch,
  ComboboxSeparator,
  ComboboxTrigger,
  ComboboxValue,
};
