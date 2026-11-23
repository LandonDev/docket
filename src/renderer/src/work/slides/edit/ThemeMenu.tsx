import type { DeckView } from "@shared/contract-work-slides";
import { DECK_THEMES } from "@shared/work/deckThemes";
import { FormatWordButton, RowPopover, useLayerOpen, type OfficeTheme } from "work-kit/format";
import { ROW_PRESS } from "../../../components/ui/press";

/**
 * Theme (the row's group 6, beside Insert; docs/DESIGN.md "The slide
 * editor"): a 288px popover of the themes a deck can be given
 * (`DECK_THEMES`), each its ten colours as one strip of swatches, its name
 * and its two fonts. One press writes it into the deck's theme (`themeEdit`)
 * and closes; the deck's layouts and masters stay its own.
 */

/** The ten a picker shows, in Office's order: the two grounds and two inks, then the six accents. */
const SHOWN = ["lt1", "dk1", "lt2", "dk2", "accent1", "accent2", "accent3", "accent4", "accent5", "accent6"] as const;

/** Whether the deck wears this theme now: its ten colours and its two fonts. */
export function wears(view: DeckView, theme: OfficeTheme): boolean {
  const own = view.theme;
  if (!own) return false;
  const same = (a: string | undefined, b: string): boolean => (a ?? "").replace(/^#/, "").toUpperCase() === b.toUpperCase();
  return SHOWN.every((slot) => same(own.colors[slot], theme.colours[slot])) && own.major === theme.fonts.heading && own.minor === theme.fonts.body;
}

export function ThemeMenu({ view, disabled, onPick }: { view: DeckView; disabled: boolean; onPick(theme: OfficeTheme): void }) {
  const state = useLayerOpen();
  const [, setOpen] = state;
  return (
    <RowPopover label="Theme" width={288} state={state} className="flex flex-col p-1.5" trigger={<FormatWordButton label="Theme" disabled={disabled} />}>
      <ThemeList
        view={view}
        onPick={(theme) => {
          setOpen(false);
          if (!wears(view, theme)) onPick(theme);
        }}
      />
    </RowPopover>
  );
}

/** The themes, one row each: its ten colours as a strip, its name and its two fonts; the deck's own marked. */
export function ThemeList({ view, onPick }: { view: DeckView; onPick(theme: OfficeTheme): void }) {
  return (
    <>
      {DECK_THEMES.map((theme) => {
        const on = wears(view, theme);
        return (
          <button
            key={theme.name}
            type="button"
            data-theme={theme.name}
            aria-current={on || undefined}
            onClick={() => onPick(theme)}
            className={`flex w-full flex-col gap-2 rounded-lg p-2 text-start ${on ? "bg-muted" : ROW_PRESS}`}
          >
            <span aria-hidden="true" className="flex h-4 overflow-hidden rounded-[4px] outline-1 -outline-offset-1 outline-(--image-outline)">
              {SHOWN.map((slot) => (
                <span key={slot} className="flex-1" style={{ backgroundColor: `#${theme.colours[slot]}` }} />
              ))}
            </span>
            <span className="flex min-w-0 flex-col">
              <span className="truncate text-[13px] leading-5">{theme.name}</span>
              <span className="truncate text-xs leading-4 text-muted-foreground">
                {theme.fonts.heading === theme.fonts.body ? theme.fonts.body : `${theme.fonts.heading} and ${theme.fonts.body}`}
              </span>
            </span>
          </button>
        );
      })}
    </>
  );
}
