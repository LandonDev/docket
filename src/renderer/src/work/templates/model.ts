import { ANY_SECTOR, fieldList, parseTemplateId, type Template } from "@shared/work/templates";

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

const byName = (a: Template, b: Template): number => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) || a.id.localeCompare(b.id);
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

/** A tile's menu: a starter's is New from this, Edit a copy and Hide; his own adds Rename… and the move between this job and all jobs. */
export function tileMenu(template: Template, jobName: string): { id: TileAction; label: string }[] {
  if (template.where === "starter")
    return [
      { id: "make", label: "New from this" },
      { id: "edit", label: "Edit a copy" },
      { id: "remove", label: "Hide" },
    ];
  return [
    { id: "make", label: "New from this" },
    { id: "edit", label: "Edit" },
    { id: "rename", label: "Rename…" },
    { id: "move", label: template.where === "job" ? "Use in all jobs" : `Only in ${jobName}` },
    { id: "remove", label: "Remove" },
  ];
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
