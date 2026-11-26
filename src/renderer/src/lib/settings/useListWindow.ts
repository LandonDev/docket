import { useMemo, useSyncExternalStore } from "react";
import { useTabGroupLabels } from "../../hooks/useTabGroupLabels";
import { LOCAL_ENVIRONMENT_ID, registry, useEnvironmentStatuses, useEnvironments } from "../connection";
import { platformOf } from "../hostPlatform";
import { nativePlatform } from "../native";
import { isWebMode } from "../nativeWeb";
import type { SettingsHas } from "../settings";
import { resolveTabGroupLabel } from "../tabGroups";
import type { WorkspaceMeta } from "../tcserver/types";
import { useWorkspaces, workspaceLabelKey } from "../tcserver/workspaces";
import { useWorkOn } from "../workSwitch";
import type { ListWindow } from "./list";

/**
 * What only a page knows of this window, told to the list: where a release folder was found (Publish), which
 * computer holds a Windows VM (its page), and the press behind "Add a computer…" once its dialog is mounted.
 */
type Known = { has: SettingsHas; vmOn: string | null; addComputer: (() => void) | null };
let known: Known = { has: {}, vmOn: null, addComputer: null };
const listeners = new Set<() => void>();
const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
/** Tells the list a fact; the same fact again changes nothing. */
export function tellSettingsList(change: Partial<Known>): void {
  const next = { ...known, ...change, has: { ...known.has, ...change.has } };
  if (next.addComputer === known.addComputer && next.vmOn === known.vmOn && next.has.publish === known.has.publish && next.has.winvm === known.has.winvm) return;
  known = next;
  for (const listener of listeners) listener();
}
export const useSettingsKnown = (): Known => useSyncExternalStore(subscribe, () => known);

/**
 * What tells a workspace apart from its same-named twins on one computer: the
 * shortest end of its parent folder's path that no twin shares ("work", or
 * "me/work" when two parents are both called work), else its whole path.
 * Null without a twin.
 */
export function workspaceHint(workspace: WorkspaceMeta, twins: readonly WorkspaceMeta[]): string | null {
  if (twins.length === 0) return null;
  const parentParts = (path: string) => path.replace(/\/+$/, "").split("/").slice(0, -1).filter(Boolean);
  const own = parentParts(workspace.path);
  const others = twins.map((twin) => parentParts(twin.path));
  for (let n = 1; n <= own.length; n++) {
    const tail = own.slice(-n).join("/");
    if (others.every((parts) => parts.slice(-n).join("/") !== tail)) return tail;
  }
  return workspace.path;
}

/** This window, as the list and the search read it. */
export function useListWindow(): ListWindow {
  const web = isWebMode();
  const environments = useEnvironments();
  const statuses = useEnvironmentStatuses();
  const all = useWorkspaces();
  const work = useWorkOn();
  // The name Customize set, as the rail says it.
  const labels = useTabGroupLabels();
  const { has, vmOn } = useSettingsKnown();
  return useMemo(() => {
    const own = registry.primaryEnvironmentId;
    const nameOf = (id: string): string => environments.find((environment) => environment.id === id)?.name ?? id;
    // With another computer linked, a job or workspace on it says so: two computers can hold a folder of one name.
    const onOf = (id: string): string | null => (environments.length > 1 && id !== own ? nameOf(id) : null);
    const label = (workspace: WorkspaceMeta): string => resolveTabGroupLabel(workspaceLabelKey(all, workspace.path, workspace.name), labels, workspace.name);
    const code = all.filter((workspace) => workspace.kind !== "work");
    return {
      web,
      platform: web ? "" : nativePlatform(),
      work,
      has,
      computers: environments
        .filter((environment) => web || environment.id !== LOCAL_ENVIRONMENT_ID)
        .map((environment) => ({
          id: environment.id,
          name: environment.name,
          platform: platformOf(environment.id),
          offline: !web && ["offline", "reconnecting"].includes(statuses.get(environment.id)?.transport ?? ""),
        })),
      vmOn,
      jobs: all.filter((workspace) => workspace.kind === "work").map((workspace) => ({ id: workspace.id, name: label(workspace), sector: workspace.sector ?? null, on: onOf(workspace.environmentId) })),
      workspaces: code.map((workspace) => ({
        id: workspace.id,
        name: label(workspace),
        // Two workspaces of one name on one computer: each says where it sits.
        on: onOf(workspace.environmentId) ?? workspaceHint(workspace, code.filter((w) => w.id !== workspace.id && w.environmentId === workspace.environmentId && w.name === workspace.name)),
      })),
    };
  }, [web, environments, statuses, all, work, labels, has, vmOn]);
}
