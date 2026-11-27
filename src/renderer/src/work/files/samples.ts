import type { FilesHome } from "@shared/contract-work-files";
import type { FileEntry } from "@shared/work/files";

/*
 * The Files place's samples (docs/agents/loading-bones.md "Samples"): a
 * folder's rows as they stand while its read is out. Nobody reads the words;
 * their lengths and the facts set give the bones their shape. A fixed clock,
 * so a row's date is a date's length.
 */

/** The clock the samples are read at: a Thursday afternoon. */
const AT = new Date(2026, 10, 19, 14, 0).getTime();
const HOUR = 3_600_000;

const entry = (n: number, kind: FileEntry["kind"], name: string, hours: number, by: string): FileEntry => ({
  key: `sample:${n}`,
  ref: null,
  folder: null,
  name,
  kind,
  changed: AT - hours * HOUR,
  by,
});

/** A folder's first screen: a folder, then files of the kinds most folders hold. */
export const SAMPLE_ENTRIES: readonly FileEntry[] = [
  entry(1, "folder", "Fall league", 3, "Landon Johnson"),
  entry(2, "sheet", "Budget Q3 final.xlsx", 5, "Dana Lee"),
  entry(3, "document", "Travel for nationals.docx", 26, "Landon Johnson"),
  entry(4, "deck", "Season kickoff.pptx", 50, "Maya Chen"),
  entry(5, "pdf", "PO request 4180.pdf", 74, "Dana Lee"),
  entry(6, "document", "Roster notes.docx", 120, "Coach Ruiz"),
];

/** A column of Columns, and a short list: three rows. */
export const SAMPLE_COLUMN: readonly FileEntry[] = SAMPLE_ENTRIES.slice(0, 3);

/** Home's first screen: two starred files and four opened lately. */
export const SAMPLE_HOME: FilesHome = {
  waiting: [],
  starred: SAMPLE_ENTRIES.slice(1, 3),
  recent: [...SAMPLE_ENTRIES.slice(3), entry(7, "sheet", "Scrim schedule.xlsx", 140, "Maya Chen")],
};
