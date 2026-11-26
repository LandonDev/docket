import { useEffect, useState } from "react";
import { thisDesktopInLine } from "../../lib/native";
import { ChoiceSelect } from "../../components/choice-select";
import { PageSection } from "../../components/page";
import {
  EDITOR_FONT_SIZES,
  isThemeKey,
  loadEditorFontSize,
  loadThemePreference,
  saveEditorFontSize,
  saveThemePreference,
  type EditorFontSize,
  type PlaceKind,
  type ThemePreference,
} from "../../lib/appearance";
import { loadMotionPreference, onMotionChange, saveMotionPreference, type MotionPreference } from "../../lib/motion";
import { applyPlaceScheme } from "../../lib/placeScheme";
import { useWorkOn } from "../../lib/workSwitch";
import { applyZoom, loadZoom } from "../../lib/zoom";
import { SettingRow, SettingSection } from "./parts/SettingRow";

const THEMES: { value: ThemePreference; label: string }[] = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

const MOTIONS: { value: MotionPreference; label: string }[] = [
  // "Follow this Mac", "Follow this PC": the computer's own setting for motion.
  { value: "system", label: `Follow ${thisDesktopInLine()}` },
  { value: "full", label: "Full" },
  { value: "reduced", label: "Reduced" },
];

const FONT_SIZES = EDITOR_FONT_SIZES.map((size) => ({ value: String(size), label: `${size}px` }));

/** The app's zoom as the View menu steps it (lib/zoom.ts): 50 to 200% in tens. */
export const TEXT_SIZES = Array.from({ length: 16 }, (_, i) => {
  const percent = 50 + i * 10;
  return { value: String(percent / 100), label: `${percent}%` };
});

const read = (): Record<PlaceKind, ThemePreference> => ({ code: loadThemePreference("code"), work: loadThemePreference("work") });

/**
 * The app's zoom, following the View menu while the page is open: Zoom In, Zoom Out and Actual Size write the same
 * key (`docket.zoom`) and change the page's size, which the window hears as a resize; another window's change comes
 * as a storage event.
 */
function useZoom(): [number, (level: number) => void] {
  const [level, setLevel] = useState(loadZoom);
  useEffect(() => {
    const follow = (): void => setLevel(loadZoom());
    const onStorage = (event: StorageEvent): void => {
      if (event.key === null || event.key === "docket.zoom") follow();
    };
    window.addEventListener("resize", follow);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener("resize", follow);
      window.removeEventListener("storage", onStorage);
    };
  }, []);
  return [
    level,
    (next) => {
      setLevel(next);
      // The level is kept before the window is asked to zoom: a window that cannot still opens at it next time.
      void applyZoom(next).catch(() => {});
    },
  ];
}

/**
 * Settings › Appearance (docs/DESIGN.md "Appearance by place"): a theme for each kind of place, Code and Work, each
 * System, Light or Dark, Work showing Code's choice until it has one of its own; with Work off on every computer there
 * is one kind of place, so one row. Then the app's text size (the View menu's zoom), the editor's and motion, which
 * follows this computer's reduce-motion setting unless chosen here (lib/motion.ts). Every row is kept in this window.
 */
export function AppearancePage() {
  const work = useWorkOn();
  const [themes, setThemes] = useState(read);
  const [fontSize, setFontSize] = useState<EditorFontSize>(loadEditorFontSize);
  const [motion, setMotion] = useState<MotionPreference>(loadMotionPreference);
  const [zoom, setZoom] = useZoom();
  useEffect(() => onMotionChange(() => setMotion(loadMotionPreference())), []);
  // A choice made in another window shows here too.
  useEffect(() => {
    const onStorage = (event: StorageEvent): void => {
      if (event.key === null || isThemeKey(event.key)) setThemes(read());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);
  const choose = (kind: PlaceKind, next: ThemePreference): void => {
    saveThemePreference(kind, next);
    setThemes(read());
    // The window changes only if the place it is on is one this choice governs.
    applyPlaceScheme();
  };
  const theme = (kind: PlaceKind, id: string, label: string) => (
    <SettingRow id={id}>
      <ChoiceSelect label={label} value={themes[kind]} options={THEMES} onChange={(next) => choose(kind, next)} />
    </SettingRow>
  );
  return (
    <>
      {work ? (
        <SettingSection of="appearance.code">
          {theme("code", "appearance.code", "Code")}
          {theme("work", "appearance.work", "Work")}
        </SettingSection>
      ) : (
        <PageSection>{theme("code", "appearance.theme", "Theme")}</PageSection>
      )}
      <SettingSection of="appearance.textSize">
        <SettingRow id="appearance.textSize">
          <ChoiceSelect label="Text size" value={String(zoom)} options={TEXT_SIZES} onChange={(next) => setZoom(Number(next))} />
        </SettingRow>
        <SettingRow id="appearance.editorSize">
          <ChoiceSelect label="Editor text size" value={String(fontSize)} options={FONT_SIZES} onChange={(next) => setFontSize(saveEditorFontSize(Number(next)))} />
        </SettingRow>
        <SettingRow id="appearance.motion">
          <ChoiceSelect label="Motion" value={motion} options={MOTIONS} onChange={saveMotionPreference} />
        </SettingRow>
      </SettingSection>
    </>
  );
}
