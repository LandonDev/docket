import type { DeckView } from "@shared/contract-work-slides";
import { DECK_THEMES } from "@shared/work/deckThemes";
import { FormatWordButton, OFFICE_THEME, RowPopover, THEME_SLOTS, useLayerOpen, type OfficeTheme } from "work-kit/format";
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

/** The deck's theme as Office keeps it: its twelve colours (Office's own where the deck names none) and two fonts. */
export function officeTheme(view: DeckView): OfficeTheme {
  const colours = { ...OFFICE_THEME.colours };
  for (const slot of THEME_SLOTS) {
    const hex = view.theme?.colors[slot]?.replace(/^#/, "");
    if (hex && /^[0-9a-f]{6}$/i.test(hex)) colours[slot] = hex.toUpperCase();
  }
  return { name: view.theme?.name || view.name, colours, fonts: { heading: view.theme?.major || OFFICE_THEME.fonts.heading, body: view.theme?.minor || OFFICE_THEME.fonts.body } };
}

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

/**
 * The themes, one row each: its ten colours as a strip, its name and its two fonts; the deck's own marked. A deck that
 * wears none of them (a school's or a company's template) has its own first, under the name its file gives it.
 */
export function ThemeList({ view, onPick }: { view: DeckView; onPick(theme: OfficeTheme): void }) {
  const own = view.theme && !DECK_THEMES.some((theme) => wears(view, theme)) ? { ...officeTheme(view), name: view.theme.name || "This deck's theme" } : null;
  return (
    <>
      {(own ? [own, ...DECK_THEMES] : DECK_THEMES).map((theme) => {
        const on = theme === own || wears(view, theme);
        return (
          <button
            key={theme === own ? "own" : theme.name}
            type="button"
            data-theme={theme === own ? "own" : theme.name}
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
