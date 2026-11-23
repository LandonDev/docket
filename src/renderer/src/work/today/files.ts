import { useMemo, type ComponentType } from "react";
import type { EntryKind, FileEntry } from "@shared/work/files";
import { dayTime } from "../../lib/duration";
import { registry } from "../../lib/connection";
import { Doc, File, Media, Pdf, Slides, Table, Video, Volume } from "../icons";
import { goTo } from "./open";
import { useEachWorkspace } from "./read";
import { useStableRows } from "./stable";
import type { TodayAnswer, TodayEnv, TodayRow, TodaySection, TodaySource, TodayWorkspace } from "./types";

/**
 * Changed by others: the files he opened or starred that someone else has
 * changed since he last saw them, as only Files can say (it keeps when he
 * saw each and knows who he is): `work.files.changed {workspaceId}` on each
 * job's host, newest first, asked again on the `work.files` push. A row
 * opens the file in a Files tab. No verbs.
 *
 * Not in `TODAY_SOURCES` until Files' read is on master (docs/agents/work-today.md
 * "Changed by others"): registering it is one line there.
 */

const SECTION: TodaySection = { id: "files", title: "Changed by others", order: 50, empty: "No one changed your files", fold: 5 };

const lead = (glyph: ComponentType<{ className?: string }>): NonNullable<TodayRow["lead"]> => ({ kind: "glyph", glyph });
/** A file's kind as its glyph, the Files view's own. */
const GLYPH: Record<EntryKind, NonNullable<TodayRow["lead"]>> = {
  folder: lead(File),
  document: lead(Doc),
  sheet: lead(Table),
  deck: lead(Slides),
  pdf: lead(Pdf),
  picture: lead(Media),
  video: lead(Video),
  audio: lead(Volume),
  text: lead(Doc),
  archive: lead(File),
  other: lead(File),
};

export const fileKey = (entry: Pick<FileEntry, "key">): string => `file:${entry.key}`;

type Ways = { open(workspace: TodayWorkspace, entry: FileEntry): void };

/**
 * Every job's changed files as rows, newest change first. A file two hosts
 * both answer for (one synced folder on two machines) is one row: the key is
 * the file's own, and the first job to give it keeps it. A folder is no row.
 */
export function fileRows(answers: readonly { workspace: TodayWorkspace; value: { entries: FileEntry[] } }[], now: number, ways: Ways): TodayRow[] {
  return answers
    .flatMap(({ workspace, value }) => value.entries.filter((entry) => entry.ref !== null).map((entry) => ({ workspace, entry })))
    .sort((a, b) => (b.entry.changed ?? 0) - (a.entry.changed ?? 0))
    .map(({ workspace, entry }, at): TodayRow => ({
      key: fileKey(entry),
      section: SECTION.id,
      sector: workspace.sector,
      title: entry.name,
      ...(entry.by ? { detail: entry.by } : {}),
      at,
      ...(entry.changed !== undefined ? { when: dayTime(entry.changed, now) } : {}),
      lead: GLYPH[entry.kind] ?? GLYPH.other,
      open: () => ways.open(workspace, entry),
    }));
}

/**
 * The file in a Files tab of its job: the host opens the tab
 * (`work.files.open`), then the window goes to that job's Files view. Files'
 * own `openInFiles` takes this over once it is on master.
 */
export function openFile(workspace: TodayWorkspace, entry: Pick<FileEntry, "ref" | "name">): void {
  void registry
    .linkOf(workspace.environmentId)
    .request("work.files.open", { workspaceId: workspace.workspaceId, ref: entry.ref, name: entry.name })
    .catch(() => {})
    .then(() => goTo(workspace, { view: "files" }));
}

const paramsOf = (workspace: TodayWorkspace) => ({ workspaceId: workspace.workspaceId });
const PUSH = { push: "work.files" };

function useFiles(env: TodayEnv): TodayAnswer {
  const read = useEachWorkspace<{ entries: FileEntry[] }>(env, "work.files.changed", paramsOf, PUSH);
  const now = env.day.from;
  const built = useMemo(() => fileRows(read.answers, now, { open: openFile }), [read.answers, now]);
  const rows = useStableRows(built);
  return useMemo<TodayAnswer>(() => ({ rows, ...(read.loading && rows.length === 0 ? { loading: true } : {}), ...(read.failed.length ? { failed: read.failed } : {}) }), [rows, read.loading, read.failed]);
}

export const source: TodaySource = { id: "files", section: SECTION, use: useFiles };
