import { ANY_SECTOR, fieldList, parseTemplateId, TEMPLATES_FOLDER, type Template } from "@shared/work/templates";

/**
 * The shelf's two groups (docs/agents/work-templates.md "The screens"): the
 * workspace's own, his templates for this job then the job's starters, and
 * "All jobs", his templates for every job then ours for any job. Each part
 * is sorted by name; a group with nothing in it is left out.
 */

export interface ShelfGroup {
  key: "job" | "all";
  label: string;
  templates: Template[];
}

/** A starter's sector, from its id (`starter:ref/game-report` is `ref`); null for one of his own. */
export function starterSector(template: Template): string | null {
  const id = parseTemplateId(template.id);
  if (!id || id.where !== "starter") return null;
  const slash = id.key.indexOf("/");
  return slash > 0 ? id.key.slice(0, slash) : null;
}

/** Whether a template stands in the job's group: his own for this job, or a starter of the job's sector. */
export function inJob(template: Template): boolean {
  if (template.where === "job") return true;
  if (template.where === "all") return false;
  const sector = starterSector(template);
  return sector !== null && sector !== ANY_SECTOR;
}

// Numbers by their worth, as the host and Files sort: "Report 2" before "Report 10".
const byName = (a: Template, b: Template): number => a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true }) || a.id.localeCompare(b.id);
const ownFirst = (list: Template[]): Template[] => [...list.filter((t) => t.where !== "starter").sort(byName), ...list.filter((t) => t.where === "starter").sort(byName)];

export function shelfGroups(templates: readonly Template[], jobName: string): ShelfGroup[] {
  const groups: ShelfGroup[] = [
    { key: "job", label: jobName, templates: ownFirst(templates.filter(inJob)) },
    { key: "all", label: "All jobs", templates: ownFirst(templates.filter((t) => !inJob(t))) },
  ];
  return groups.filter((g) => g.templates.length > 0);
}

/** The ids a tile's menu answers. */
export type TileAction = "make" | "edit" | "rename" | "move" | "remove";

/** A tile's menu row, as data: its glyph is named here and drawn by the view. */
export type TileRow =
  | { kind: "item"; id: TileAction; label: string; glyph: "new" | "edit" | "copy" | "rename" | "everywhere" | "job" | "delete" | "hide"; danger?: true }
  | { kind: "sep" };

/**
 * A tile's menu: a starter's is New from this, Edit a copy and Hide; his own adds
 * Rename… and the move between this job and all jobs, then Remove, set apart as the
 * one row that deletes. Hide stays plain: it is undone with one press.
 */
export function tileMenu(template: Template, jobName: string): TileRow[] {
  if (template.where === "starter")
    return [
      { kind: "item", id: "make", label: "New from this", glyph: "new" },
      { kind: "item", id: "edit", label: "Edit a copy", glyph: "copy" },
      { kind: "item", id: "remove", label: "Hide", glyph: "hide" },
    ];
  return [
    { kind: "item", id: "make", label: "New from this", glyph: "new" },
    // A template for all jobs lies in the host's own data, which Files does not open: he edits his own copy for
    // this job, as with a starter. Only his job's own is edited in place.
    template.where === "job" ? { kind: "item", id: "edit", label: "Edit", glyph: "edit" } : { kind: "item", id: "edit", label: "Edit a copy", glyph: "copy" },
    { kind: "item", id: "rename", label: "Rename…", glyph: "rename" },
    template.where === "job"
      ? { kind: "item", id: "move", label: "Use in all jobs", glyph: "everywhere" }
      : { kind: "item", id: "move", label: `Only in ${jobName}`, glyph: "job" },
    { kind: "sep" },
    { kind: "item", id: "remove", label: "Remove", glyph: "delete", danger: true },
  ];
}

/** The empty shelf's line: what he hid, when he hid it all. */
export function hiddenLine(hidden: number): string | null {
  if (hidden <= 0) return null;
  return hidden === 1 ? "1 starter is hidden" : `${hidden} starters are hidden`;
}

/** One message for an Add or a drop that left some files out: each by name, with why. */
export function refusedLine(refused: readonly { name: string; why: string }[]): { title: string; description?: string } | null {
  if (refused.length === 0) return null;
  if (refused.length === 1) return { title: `${refused[0]!.name} was not added`, description: refused[0]!.why };
  return { title: `${refused.length} files were not added`, description: refused.map((r) => `${r.name}: ${r.why}`).join("\n") };
}

/** The name a source's file gives the Save dialog: its stem, for a file on disk or a Microsoft file by path or name. */
export function sourceStem(source: { at: string; path?: string; name?: string; ref?: { kind: string; path?: string } }): string {
  if (source.at === "file" && source.path) return stemOf(baseName(source.path));
  if (source.at === "microsoft") {
    if (source.ref?.kind === "path" && source.ref.path) return stemOf(baseName(source.ref.path));
    if (source.name) return stemOf(source.name);
  }
  return "";
}

/** "Asks for Client and Game." for a template with fields; null for one with none. */
export function asksLine(fields: readonly string[]): string | null {
  return fields.length ? `Asks for ${fieldList(fields)}.` : null;
}

/** A folder's name for the dialog's "Kept in" line: the name given, else a path's last part. */
export function folderName(into: { at: string; path?: string } | undefined, name?: string): string | null {
  if (name) return name;
  if (into?.at !== "file" || !into.path) return null;
  const parts = into.path.split(/[\\/]+/).filter(Boolean);
  return parts.at(-1) ?? null;
}

/** A path's last part: the file's name. */
export const baseName = (path: string): string => path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);

/** A file's name without its extension, for the Save dialog's Name. */
export const stemOf = (name: string): string => {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
};

/** Whether Edit copies the template first: a starter, or one for all jobs, which lie outside what Files opens. */
export const editsACopy = (template: Template): boolean => template.where !== "job";

/** Whether a `work.files` push's folder (`file:<host>:<path>`, `refKey`) is a job's Templates folder: then the shelf changed too. */
export function namesTemplatesFolder(at: string | undefined): boolean {
  if (!at?.startsWith("file:")) return false;
  const parts = at.split(/[\\/]+/).filter(Boolean);
  return parts.at(-1) === TEMPLATES_FOLDER;
}

/** A host's words as a sentence: a full stop at the end when they have no stop of their own. */
/** "Still to fill: Client and Budget": the fields a made file still holds as written, said once it opens; null for none. */
export const unfilledLine = (unfilled: readonly string[]): string | null => (unfilled.length ? `Still to fill: ${fieldList(unfilled)}` : null);

export const sentence = (words: string): string => (/[.!?…]$/.test(words.trim()) ? words.trim() : `${words.trim()}.`);

/** What a kind is called to someone who cannot see its glyph or tint. */
export const KIND_WORD = { document: "Document", sheet: "Sheet", deck: "Deck" } as const;
