import { useState } from "react";
import { ChoiceSelect } from "../../components/choice-select";
import { PageRow, PageSection } from "../../components/page";
import {
  EDITOR_FONT_SIZES,
  loadEditorFontSize,
  loadThemePreference,
  saveEditorFontSize,
  saveThemePreference,
  type EditorFontSize,
  type PlaceKind,
  type ThemePreference,
} from "../../lib/appearance";
import { applyPlaceScheme } from "../../lib/placeScheme";
import { useWorkOn } from "../../lib/workSwitch";

const THEMES: { value: ThemePreference; label: string }[] = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

const FONT_SIZES = EDITOR_FONT_SIZES.map((size) => ({ value: String(size), label: `${size}px` }));

const read = (): Record<PlaceKind, ThemePreference> => ({ code: loadThemePreference("code"), work: loadThemePreference("work") });

/** A theme for each kind of place (docs/DESIGN.md "Appearance by place"):
 *  Code and Work, each System, Light or Dark. Work shows Code's choice until
 *  it has one of its own. With Work off on every host there is one kind of
 *  place, so one row. */
export function AppearancePage() {
  const work = useWorkOn();
  const [themes, setThemes] = useState(read);
  const [fontSize, setFontSize] = useState<EditorFontSize>(loadEditorFontSize);
  const choose = (kind: PlaceKind, next: ThemePreference): void => {
    saveThemePreference(kind, next);
    setThemes(read());
    // The window changes only if the place it is on is one this choice governs.
    applyPlaceScheme();
  };
  const theme = (kind: PlaceKind, label: string) => (
    <PageRow title={label}>
      <ChoiceSelect label={label} value={themes[kind]} options={THEMES} onChange={(next) => choose(kind, next)} />
    </PageRow>
  );
  const editor = (
    <PageRow title="Editor font size">
      <ChoiceSelect label="Editor font size" value={String(fontSize)} options={FONT_SIZES} onChange={(next) => setFontSize(saveEditorFontSize(Number(next)))} />
    </PageRow>
  );
  if (!work)
    return (
      <PageSection>
        {theme("code", "Theme")}
        {editor}
      </PageSection>
    );
  return (
    <>
      <PageSection title="Theme">
        {theme("code", "Code")}
        {theme("work", "Work")}
      </PageSection>
      <PageSection>{editor}</PageSection>
    </>
  );
}
