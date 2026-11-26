import { registry } from "../lib/connection";
import { useCallback, useEffect } from "react";
import { ReadFailure } from "./settings/parts/ReadFailure";
import type { AppshotDestination } from "@server/shared/appshots";
import {
  loadAppshotSettings,
  refreshAppshotPermissions,
  setAppshotSettings,
  useAppshotPermissions,
  useAppshotSettings,
  useAppshotSettingsStatus,
} from "../lib/appshots";
import { ChoiceSelect, type Choice } from "../components/choice-select";
import { PageRowsSkeleton, PageSection } from "../components/page";
import { SettingSwitch } from "../components/setting-switch";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../components/ui/empty";
import { Permissions } from "./settings/parts/Permissions";
import { SettingRow } from "./settings/parts/SettingRow";

const DESTINATIONS: Choice<AppshotDestination>[] = [
  { value: "automatic", label: "Automatic" },
  { value: "last-chat", label: "The last chat" },
  { value: "new-chat", label: "A new chat" },
];

const POLL_MS = 5000;

/**
 * Settings › Appshots: the capture switch, where a shot lands and its sound, kept by this Mac (`appshots.*` through
 * lib/appshots.ts, which moves the control at once, puts a refused value back and says why under its row). A macOS
 * grant shows here only while it is missing, as the reason the double ⌘ does nothing; both are listed on Computer use.
 */
export function AppshotsPage() {
  const settings = useAppshotSettings();
  const { loaded, loadError, writeError } = useAppshotSettingsStatus();
  const errorOf = (key: keyof typeof settings) => (writeError?.key === key ? writeError.message : undefined);
  const perms = useAppshotPermissions();

  // Grants flip in System Settings, outside our window: poll while the page
  // is open, and again the moment the window comes back.
  useEffect(() => {
    const tick = () => void refreshAppshotPermissions().catch(() => undefined);
    tick();
    const timer = window.setInterval(tick, POLL_MS);
    window.addEventListener("focus", tick);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", tick);
    };
  }, []);

  const prompt = useCallback(() => void refreshAppshotPermissions(true).catch(() => undefined), []);

  if (perms && !perms.available) {
    return (
      <Empty className="py-10">
        <EmptyHeader>
          <EmptyTitle>Appshots need macOS</EmptyTitle>
          <EmptyDescription>This build has no capture helper.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <PageSection>
      {loaded ? (
        <>
          <SettingRow id="appshots.on" error={errorOf("enabled")}>
            <SettingSwitch
              label="Appshots"
              on={settings.enabled}
              onChange={(on) => {
                setAppshotSettings({ enabled: on });
                // The hotkey monitor hears nothing until Accessibility is granted,
                // so turning the feature on asks for what is missing right away.
                if (on && perms && !(perms.screen && perms.ax)) prompt();
              }}
            />
          </SettingRow>
          <SettingRow id="appshots.into" description="Automatic uses the open chat, else a new one." error={errorOf("destination")}>
            <ChoiceSelect label="Add the window to" value={settings.destination} options={DESTINATIONS} onChange={(destination) => setAppshotSettings({ destination })} />
          </SettingRow>
          <SettingRow id="appshots.sound" error={errorOf("sound")}>
            <SettingSwitch label="Shutter sound" on={settings.sound} onChange={(sound) => setAppshotSettings({ sound })} />
          </SettingRow>
        </>
      ) : loadError ? (
        <ReadFailure computer={registry.primary().environmentId} error={loadError} retry={loadAppshotSettings} />
      ) : (
        <PageRowsSkeleton rows={[{ control: "switch" }, { description: true, control: "select" }, { control: "switch" }]} />
      )}
      <Permissions
        missingOnly
        accessibility={perms ? perms.ax : null}
        screen={perms ? perms.screen : null}
        without={{ accessibility: "Appshots cannot hear the double ⌘ without it", screen: "Appshots cannot see a window without it" }}
      />
    </PageSection>
  );
}
