import { useEffect, useState } from "react";
import type { BuildConfig } from "@server/shared/build";
import { registry } from "../../lib/connection";
import { useHostRead } from "../../lib/connection/hostRead";
import { BusyLabel, Button } from "../../components/ui/button";
import { OPEN_SETTINGS_EVENT } from "../../lib/monaco/debugTab";
import { workspaceSettingsSection } from "../../lib/settings";
import { useWorkspaces } from "../../lib/tcserver/workspaces";
import { PageError, PageRowsSkeleton } from "../../components/page";
import { useLinkMay } from "../../lib/linkMay";
import { CommitField } from "../../surfaces/settings/hosts/CommitField";
import { SettingRow, SettingSection } from "../../surfaces/settings/parts/SettingRow";
import { useSaved, type Saved } from "../../surfaces/settings/parts/useSaved";
import { Input } from "../../components/ui/input";

/**
 * A workspace's build command (the Build rail tab, and what After each turn's fresh build runs). Placeholders show
 * what the app detects from the checkout; an empty command keeps that detection. `BuildFields` is the project sheet's
 * pair, stacked label over field.
 */

export const BUILD_EMPTY: BuildConfig = { command: "", outputs: "" };

/** An override with no command means "inherit" — store nothing. */
export const buildOrNull = (c: BuildConfig | null): BuildConfig | null =>
  c && c.command.trim() ? { command: c.command.trim(), outputs: c.outputs.trim() } : null;

export function BuildFields({
  value,
  onChange,
  detected,
}: {
  value: BuildConfig;
  onChange: (next: BuildConfig) => void;
  detected: BuildConfig | null;
}) {
  const fields = [
    { key: "command" as const, label: "Command", aria: "Build command", placeholder: detected?.command ?? "mvn -B package" },
    { key: "outputs" as const, label: "What it makes", aria: "What it makes", placeholder: detected?.outputs || "target/*.jar" },
  ];
  return (
    <>
      {fields.map((f) => (
        <label key={f.key} className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-muted-foreground">{f.label}</span>
          <Input value={value[f.key]} onChange={(e) => onChange({ ...value, [f.key]: e.target.value })} placeholder={f.placeholder} spellCheck={false} aria-label={f.aria} className="font-mono text-xs" />
        </label>
      ))}
    </>
  );
}

/**
 * A code workspace's Build section: Command and What it makes, each a field that commits on Enter or blur and saves
 * with the mark; a refused value snaps back with the row's red line. The fields stay away until `build.get` answers,
 * so nothing typed into an empty stand-in can save over the real config; no answer is the section's error and Retry.
 * Placeholders show what the app detects from the checkout; an empty command keeps that detection. A key that may not
 * set it reads the values as words.
 */
export function BuildEditor({ workspaceId }: { workspaceId: string }) {
  const workspace = useWorkspaces().find((w) => w.id === workspaceId);
  const path = workspace?.path;
  const environmentId = workspace?.environmentId;
  const link = environmentId ? registry.linkOf(environmentId) : null;
  const may = useLinkMay(environmentId ?? "", "build.set");
  const read = useHostRead(
    link,
    async () => (await link!.request<BuildConfig | null>("build.get", { workspaceId })) ?? BUILD_EMPTY,
    workspaceId,
  );
  const config = read.value;
  const [detected, setDetected] = useState<BuildConfig | null>(null);
  const command = useSaved();
  const makes = useSaved();

  useEffect(() => {
    if (!environmentId || !path) return;
    let live = true;
    void registry
      .linkOf(environmentId)
      .request<BuildConfig | null>("build.detect", { path })
      .then((d) => live && setDetected(d))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [environmentId, workspaceId, path]);

  const commit = (saved: Saved, patch: Partial<BuildConfig>): Promise<boolean> => {
    if (!environmentId || !config) return Promise.resolve(false);
    const next = { ...config, ...patch };
    return saved.run(async () => {
      await registry.linkOf(environmentId).request("build.set", { workspaceId, config: buildOrNull(next) });
      read.set(next);
    });
  };

  const failed = config === undefined && read.error !== null;
  return (
    <SettingSection of="ws.command">
      {config ? (
        <>
          <SettingRow id="ws.command" saved={may ? command : undefined} wide={may} description={may ? "Runs in the checkout through your login shell" : config.command || detected?.command || "None"}>
            {may ? (
              <CommitField aria-label="Build command" value={config.command} placeholder={detected?.command ?? "mvn -B package"} spellCheck={false} className="w-64 font-mono text-xs" onCommit={(value) => commit(command, { command: value })} />
            ) : null}
          </SettingRow>
          <SettingRow id="ws.makes" saved={may ? makes : undefined} wide={may} description={may ? "Like out/** or target/*.jar" : config.outputs || detected?.outputs || "None"}>
            {may ? (
              <CommitField aria-label="What it makes" value={config.outputs} placeholder={detected?.outputs || "target/*.jar"} spellCheck={false} className="w-64 font-mono text-xs" onCommit={(value) => commit(makes, { outputs: value })} />
            ) : null}
          </SettingRow>
        </>
      ) : failed ? (
        <PageError
          action={
            <Button variant="ghost" size="sm" onClick={read.retry}>
              <BusyLabel busy={false} label="Retry" />
            </Button>
          }
        >
          {read.error}
        </PageError>
      ) : (
        <div data-testid="build-skeleton">
          <PageRowsSkeleton rows={2} description control="field" />
        </div>
      )}
    </SettingSection>
  );
}

// ── deep link from the Build rail tab ─────────────────────────────────

let requestedFocus = false;

/** Open Settings on this workspace's page with its Build section in view. */
export function openBuildSettings(workspaceId: string): void {
  requestedFocus = true;
  window.dispatchEvent(new CustomEvent(OPEN_SETTINGS_EVENT, { detail: workspaceSettingsSection(workspaceId) }));
}

/** Whether a deep link asked for the Build section, consumed once. */
export function takeRequestedBuildFocus(): boolean {
  const focus = requestedFocus;
  requestedFocus = false;
  return focus;
}
