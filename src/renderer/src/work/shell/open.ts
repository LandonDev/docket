import { requestSettings } from "../../lib/monaco/debugTab";
import { workspaceSettingsSection } from "../../lib/settings";

/** Settings → Work: the switch, where Work runs. */
export function openWorkSettings(): void {
  requestSettings("work");
}

/** Settings → Connections: each host's LifeOS sign-in and every other sign-in Work leans on. */
export function openConnections(): void {
  requestSettings("connections");
}

/** A workspace's own settings page; a Work workspace's holds its Work settings. */
export function openWorkspacePage(workspaceId: string): void {
  requestSettings(workspaceSettingsSection(workspaceId));
}
