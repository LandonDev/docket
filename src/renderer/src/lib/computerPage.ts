import { LOCAL_ENVIRONMENT_ID } from "./connection/registry";
import { isWebMode } from "./nativeWeb";
import { computerSettingsSection, type SettingsSectionId } from "./settings";

/**
 * A computer's own page in Settings (docs/agents/settings.md "Other computers"): Sharing for this computer in the
 * desktop app, else `computer:<environmentId>` (at /ui the page's host is a computer of the Computers list).
 */
export function computerPageOf(environmentId: string, web = isWebMode()): SettingsSectionId {
  return !web && environmentId === LOCAL_ENVIRONMENT_ID ? "sharing" : computerSettingsSection(environmentId);
}
