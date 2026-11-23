import { useId, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { Dialog, DialogContent, DialogTitle } from "../components/ui/dialog";
import { GroupInput, InputGroup } from "../components/ui/input";
import { MENU_ROW } from "../components/ui/menu-row";
import { Separator } from "../components/ui/separator";
import { cn } from "../lib/cn";
import { Search } from "./icons";

type FrameProps = {
  label: string;
  search: RefObject<HTMLInputElement | null>;
  query: string;
  onQuery: (query: string) => void;
  onSearchKey: (e: KeyboardEvent<HTMLInputElement>) => void;
  /** Stands in the field before his words, muted: what the list is narrowed to (Work search's one kind). */
  leading?: ReactNode;
  /** The field's own end: a control that belongs to the search (Work search's scope, its spinner). */
  trailing?: ReactNode;
  /** The list the field drives, by its id, and the highlighted option's: the field then says it is a combobox and names the row the arrows are on, for a reader that cannot see the highlight. */
  listId?: string;
  activeId?: string | null;
  /** false: no rule under the field, for a picker with no row to show under it. */
  rule?: boolean;
  /** The most the field takes, where what it asks has a limit: a longer paste is cut at it. */
  maxLength?: number;
  children: ReactNode;
};

/**
 * The frame of a go-to picker (Go to File, Go to Symbol, Work search): a
 * Dialog near the top of the window with the search field on top and the
 * list under it. Escape and a press outside close it.
 */
export function PickerDialog({
  open = true,
  label,
  search,
  query,
  onQuery,
  onSearchKey,
  onClose,
  leading,
  trailing,
  listId,
  activeId,
  rule,
  maxLength,
  children,
  ...data
}: FrameProps & {
  open?: boolean;
  /** `reason` is the dialog's own word for how it was asked to close (`escape-key`, `outside-press`). */
  onClose: (reason?: string) => void;
} & Record<`data-${string}`, boolean>) {
  return (
    <Dialog open={open} onOpenChange={(next, details) => (next ? undefined : onClose(details?.reason))}>
      <DialogContent
        showCloseButton={false}
        instant
        initialFocus={search}
        className="top-[12%] translate-y-0 starting:translate-y-0 gap-0 p-1 sm:max-w-[560px]"
        {...data}
      >
        <DialogTitle className="sr-only">{label}</DialogTitle>
        <PickerFrame label={label} search={search} query={query} onQuery={onQuery} onSearchKey={onSearchKey} leading={leading} trailing={trailing} listId={listId} activeId={activeId} rule={rule} maxLength={maxLength}>
          {children}
        </PickerFrame>
      </DialogContent>
    </Dialog>
  );
}

/** What the dialog holds: the field, the rule under it, the list. Its own piece so a design page can draw a picker with no dialog round it. */
export function PickerFrame({ label, search, query, onQuery, onSearchKey, leading, trailing, listId, activeId, rule = true, maxLength, children }: FrameProps) {
  const leadingId = useId();
  return (
    <>
      {/* The frame's radius less its 4px inset (16 − 4 = 12px), as a row's. */}
      {/* The glyph in a row's own 16px slot, 12px in (11 and the border), so his words stand over the titles they find. */}
      <InputGroup
        leading={
          <span className="grid size-4 place-items-center">
            <Search className="size-3.5" />
          </span>
        }
        trailing={trailing}
        className="h-9 rounded-xl border-transparent pl-[11px]"
      >
        {leading ? (
          <span id={leadingId} data-picker-leading className="shrink-0 text-[13px] text-muted-foreground">
            {leading}
          </span>
        ) : null}
        <GroupInput
          ref={search}
          value={query}
          // What stands before his words is the field's hint then: "Mail" and "Search Work" side by side read as one phrase.
          placeholder={leading ? undefined : label}
          maxLength={maxLength}
          aria-label={label}
          // What the list is narrowed to is part of what the field is, for a reader that cannot see it stand there.
          aria-describedby={leading ? leadingId : undefined}
          spellCheck={false}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          {...(listId ? { role: "combobox", "aria-autocomplete": "list" as const, "aria-expanded": true, "aria-controls": listId, "aria-activedescendant": activeId ?? undefined } : {})}
          onChange={(e) => onQuery(e.target.value)}
          onKeyDown={onSearchKey}
        />
      </InputGroup>
      {/* Across the frame's 4px inset to both edges: a full-width
          separator shifted by -mx-1 stopped 8px short of the right. */}
      {/* 4px over it as under it: the field's focus ring never sits on the line. */}
      {rule ? <Separator data-picker-rule className="-mx-1 my-1 data-[orientation=horizontal]:w-auto" /> : null}
      {children}
    </>
  );
}

/** A picker's empty or waiting line: one muted row in a row's box, never
 *  an empty state (docs/DESIGN.md "Loading and empty states"). */
export function PickerNote({ children }: { children: ReactNode }) {
  return <p data-picker-note className="flex h-7 items-center px-3 text-[13px] text-muted-foreground">{children}</p>;
}

/** One row of a picker list, in a menu row's box (`MENU_ROW`: 28px, 12px
 *  in, 8px from glyph to label) with the frame's radius less its 4px inset
 *  (16 − 4 = 12px); the highlighted row is a muted fill. The line is 20px,
 *  whatever the dialog's own body sets (22px), so the row is 28px: it
 *  stands after `MENU_ROW`, whose font size would otherwise take the line
 *  with it in the class merge. */
export function pickerRowClass(highlighted: boolean): string {
  return cn(
    "flex w-full cursor-default items-center rounded-xl text-left",
    MENU_ROW,
    "leading-5",
    highlighted && "bg-muted",
  );
}
