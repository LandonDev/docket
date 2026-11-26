import { nameInLine } from "../hostWords";
import {
  SETTINGS_GROUPS,
  computerSettingsSection,
  settingsGroupLabel,
  settingsSectionTitle,
  visibleSettingsSections,
  workspaceSettingsSection,
  type SettingsHas,
  type SettingsPageId,
} from "../settings";

/**
 * The Settings list as one window draws it (docs/agents/settings.md "By place"): its groups in order, each a heading
 * and rows. The rail draws it (chrome/SettingsRail.tsx) and search reads it (lib/settings/search.ts), so a page the
 * list lacks is never a result.
 */
export type ListWindow = {
  /** The box's web page; else the desktop app. */
  web: boolean;
  /** This window's `process.platform`; "" at /ui. */
  platform: string;
  /** Work is on for some computer. */
  work: boolean;
  has: SettingsHas;
  /** The computers besides this window's own, in the registry's order; at /ui the one computer that serves the page. */
  computers: readonly { id: string; name: string; platform?: string; offline?: boolean }[];
  /** The environment id of the computer that holds the Windows VM: its row stands right under that computer's. */
  vmOn?: string | null;
  jobs: readonly { id: string; name: string; sector?: string | null; on?: string | null }[];
  workspaces: readonly { id: string; name: string; on?: string | null }[];
};

export type ListRow = {
  id: SettingsPageId;
  label: string;
  /** The page's own title where it is not its row's label ("Work" for the Work group's Setup, "Threads on this Mac"). */
  title?: string;
  kind: "page" | "computer" | "job" | "workspace";
  /** The muted word at the row's end: the computer a job or workspace is on, "Offline", "in the box". */
  end?: string;
  platform?: string;
  sector?: string | null;
};

export type ListGroup = { id: string; label: string; rows: ListRow[] };

export function settingsList(window: ListWindow): ListGroup[] {
  const sections = visibleSettingsSections(window.web, window.platform === "darwin", window.work, { ...window.has, others: window.computers.length > 0 });
  const words = { web: window.web, platform: window.platform };
  const groups: ListGroup[] = SETTINGS_GROUPS.map((group) => ({
    id: group.id,
    label: settingsGroupLabel(group.id, words),
    rows: sections
      .filter((section) => section.group === group.id)
      .map((section): ListRow => ({ id: section.id, label: section.label, kind: "page", ...(section.title ? { title: settingsSectionTitle(section.id, window.platform) } : {}) })),
  }));
  const of = (id: string): ListGroup => groups.find((group) => group.id === id)!;
  // Each computer has a row; the Windows VM, a computer inside one of them, stands right under the one that holds it.
  const others = of("others");
  const vm = others.rows.find((row) => row.id === "winvm");
  const holder = window.computers.find((computer) => computer.id === window.vmOn);
  others.rows = window.computers.flatMap((computer): ListRow[] => [
    { id: computerSettingsSection(computer.id), label: computer.name, kind: "computer", platform: computer.platform, ...(computer.offline ? { end: "Offline" } : {}) },
    ...(vm && computer === holder ? [{ ...vm, end: `in ${nameInLine(computer.name)}` }] : []),
  ]);
  if (vm && !holder) others.rows.push(vm);
  const own = (items: ListWindow["jobs"], kind: "job" | "workspace"): ListRow[] => {
    // Where a thing is goes at its row's end only when the rows differ: one word on every row says nothing.
    const differ = new Set(items.map((item) => item.on ?? "")).size > 1;
    return items.map((item): ListRow => ({
      id: workspaceSettingsSection(item.id),
      label: item.name,
      kind,
      ...(differ && item.on ? { end: nameInLine(item.on) } : {}),
      ...("sector" in item ? { sector: (item as { sector?: string | null }).sector ?? null } : {}),
    }));
  };
  const last = groups.pop()!;
  if (window.work && window.jobs.length) groups.push({ id: "jobs", label: settingsGroupLabel("jobs", words), rows: own(window.jobs, "job") });
  if (window.workspaces.length) groups.push({ id: "workspaces", label: settingsGroupLabel("workspaces", words), rows: own(window.workspaces, "workspace") });
  groups.push(last);
  return groups.filter((group) => group.rows.length > 0 || group.id === "others");
}

/** Every page of the list, in order, with its group's heading. */
export const listPages = (groups: readonly ListGroup[]): { row: ListRow; group: ListGroup }[] => groups.flatMap((group) => group.rows.map((row) => ({ row, group })));
