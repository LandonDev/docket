import { requestSettings } from "../../lib/monaco/debugTab";
import { workspaceSettingsSection } from "../../lib/settings";

/** Settings → Work: the switch, LifeOS's sign-in, where Work runs. */
export function openWorkSettings(): void {
  requestSettings("work");
}

/** A workspace's own settings page; a Work workspace's holds its Work settings. */
export function openWorkspacePage(workspaceId: string): void {
  requestSettings(workspaceSettingsSection(workspaceId));
}
