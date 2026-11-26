import type { ComponentProps, ReactNode } from "react";
import { ChevronRight } from "../../../chrome/icons";
import { PageRow, PageSection } from "../../../components/page";
import { cn } from "../../../lib/cn";
import { settingEntry, settingWords, type SettingVars } from "../../../lib/settings/map";
import { FOUND_ROW } from "../../../lib/settings/reveal";
import { SaveMark } from "./SaveMark";
import type { Saved } from "./useSaved";

type RowProps = Omit<ComponentProps<typeof PageRow>, "title">;

/**
 * The cue at the end of a row that opens something and has no control of its own: a still chevron, muted. A row is
 * "open" by this mark at rest, not only by its hover (docs/agents/settings.md "One home"). A list's own rows that
 * open a page, a sheet or a dialog (a computer, a job, a project) draw it the same way.
 */
export function OpenCue() {
  return <ChevronRight aria-hidden data-slot="open-cue" className="size-3.5 shrink-0 text-muted-foreground" />;
}

/**
 * One row of Settings: a `PageRow` named by the map (lib/settings/map.ts), so the page, the search and the landing
 * note's table say one name. `id` is the row's map id and its address (`requestSettings(page, id)` scrolls to it and
 * holds a fill on it); `vars` fills the name's "{mac}", "{computer}", "{n}" and "{version}"; `saved` is its
 * `useSaved`, drawn as the mark before the control and the red line under the row. `shown` marks a row that only
 * shows another page's setting (a permission still missing, a state with its way there): the same name, no second home.
 * A row with `onOpen` and no control of its own ends in `OpenCue`.
 */
export function SettingRow({
  id,
  vars,
  saved,
  shown = false,
  error,
  className,
  children,
  ...row
}: RowProps & { id: string; vars?: SettingVars; saved?: Saved; shown?: boolean }) {
  return (
    <PageRow
      {...row}
      data-setting={id}
      data-shown={shown ? "" : undefined}
      title={settingWords(settingEntry(id).title, vars)}
      error={error ?? saved?.error}
      className={cn(FOUND_ROW, className)}
    >
      {saved || children ? (
        <>
          {saved ? <SaveMark state={saved.state} /> : null}
          {children}
        </>
      ) : row.onOpen ? (
        <OpenCue />
      ) : null}
    </PageRow>
  );
}

/**
 * A section named by the map: `of` is any row in it (its heading is that row's `section`), and where that row is a
 * `list` (the section is rows named by what they hold: devices, add-ons) the section itself is the map's row.
 */
export function SettingSection({
  of,
  vars,
  children,
  ...section
}: Omit<ComponentProps<typeof PageSection>, "title"> & { of: string; vars?: SettingVars; children: ReactNode }) {
  const entry = settingEntry(of);
  return (
    <PageSection {...section} data-setting={entry.kind === "list" ? of : undefined} title={entry.section ? settingWords(entry.section, vars) : undefined}>
      {children}
    </PageSection>
  );
}
