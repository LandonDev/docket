import { useState } from "react";
import type { CodeSettings } from "@server/shared/contract-code";
import { ChoiceSelect } from "../../components/choice-select";
import { PageRow } from "../../components/page";
import { BusyLabel, Button } from "../../components/ui/button";
import { Progress } from "../../components/ui/progress";
import { BUNDLED_RELEASE } from "../../lib/bundledRelease";
import { LOCAL_ENVIRONMENT_ID, WEB_ENVIRONMENT_ID, registry, useEnvironmentStatus, useEnvironments } from "../../lib/connection";
import { useHostRead } from "../../lib/connection/hostRead";
import { useDeployDrift } from "../../lib/deployDrift";
import { requestSettings } from "../../lib/monaco/debugTab";
import { openUrl } from "../../lib/native";
import { computerSettingsSection } from "../../lib/settings";
import { useComputerNames } from "../../lib/settings/computerName";
import { updateStore, useUpdateSnapshot } from "../../lib/updateStore";
import { MANUAL_DOWNLOAD_URL, canRetry } from "../../lib/updater";
import { releaseNotesChunk } from "../chunks";
import { SettingRow, SettingSection } from "./parts/SettingRow";
import { useSaved } from "./parts/useSaved";

/**
 * Settings › Updates (docs/agents/settings.md "This Mac"): Docket on this Mac, with the updater's one button, its
 * release notes and the computer it takes quick updates from; then each linked computer's version, a row that opens
 * that computer's page, where its Update… is. Desktop only: the page at /ui updates with the computer that serves it.
 */
export function UpdatesPage({ onOpenWhatsNew }: { onOpenWhatsNew: (version: string, markdown?: string) => void }) {
  return (
    <>
      <SettingSection of="updates.version">
        <VersionRow />
        <ReleaseNotesRow onOpenWhatsNew={onOpenWhatsNew} />
        <QuickUpdatesRow />
      </SettingSection>
      <OtherComputers />
    </>
  );
}

/** A line ends on its own stop: a subject cut short already ends on "…". */
const sentence = (line: string) => (/[.!?…]$/.test(line) ? line : `${line}.`);

function VersionRow() {
  const snapshot = useUpdateSnapshot();
  const downloading = snapshot.phase === "downloading";
  const ready = snapshot.phase === "ready";
  const busy = snapshot.phase === "checking" || downloading;
  const hasUpdate = snapshot.phase === "available";
  const canApply = snapshot.canApply === true;

  const status = downloading
    ? `Downloading ${snapshot.availableVersion ?? "the update"}…`
    : ready
      ? snapshot.codeSubject
        ? `Quick update: ${sentence(snapshot.codeSubject)} Restart to finish.`
        : `Release ${snapshot.availableVersion} is downloaded. Restart to finish.`
      : snapshot.phase === "checking"
        ? "Checking…"
        : snapshot.phase === "error"
          ? (snapshot.error ?? "Update failed.")
          : hasUpdate
            ? canApply
              ? (snapshot.notes ?? `Release ${snapshot.availableVersion} is ready.`)
              : `Release ${snapshot.availableVersion} is out. Dev build: updates apply to the installed app.`
            : snapshot.canApply === false
              ? "Dev build: updates apply to the installed app."
              : "Up to date";

  const retry = canRetry(snapshot);
  const actionable = (hasUpdate && canApply) || ready || retry;
  const failed = snapshot.phase === "error";
  return (
    <SettingRow
      id="updates.version"
      vars={{ version: snapshot.currentVersion }}
      description={
        failed ? undefined : (
          <>
            {status}
            {downloading ? <Progress aria-label="Download" value={Math.round(snapshot.percent ?? 0)} className="mt-2 w-64" /> : null}
          </>
        )
      }
      error={
        failed ? (
          <>
            {status}
            {canApply ? (
              <>
                {" "}
                <Button
                  variant="link"
                  size="xs"
                  className="h-auto px-0 text-xs after:absolute after:inset-x-0 after:-inset-y-1 after:content-['']"
                  onClick={() => void openUrl(MANUAL_DOWNLOAD_URL)}
                >
                  Download the installer
                </Button>
              </>
            ) : null}
          </>
        ) : undefined
      }
    >
      <Button variant={actionable ? "default" : "secondary"} size="sm" onClick={() => void (actionable ? updateStore.install() : updateStore.check(true))} disabled={busy}>
        <BusyLabel busy={busy} label={updateActionLabel(snapshot.phase, { canApply, retry })} busyLabel="Check for updates" />
      </Button>
    </SettingRow>
  );
}

/** The release notes: a waiting update's from the feed, else the ones this build shipped with (its version is the
 *  row above's). */
function ReleaseNotesRow({ onOpenWhatsNew }: { onOpenWhatsNew: (version: string, markdown?: string) => void }) {
  const snapshot = useUpdateSnapshot();
  const waiting = snapshot.phase === "available" && snapshot.availableVersion && snapshot.notes ? snapshot : null;
  const open = () => (waiting ? onOpenWhatsNew(waiting.availableVersion!, waiting.notes!) : onOpenWhatsNew(BUNDLED_RELEASE.version, BUNDLED_RELEASE.notes));
  return (
    <SettingRow id="updates.notes" description={waiting ? `For ${waiting.availableVersion}` : undefined}>
      <span className="contents" {...releaseNotesChunk.intent}>
        <Button variant="ghost" size="sm" onClick={open}>
          Open
        </Button>
      </span>
    </SettingRow>
  );
}

/** The update button's word for the updater's phase. */
export function updateActionLabel(phase: ReturnType<typeof useUpdateSnapshot>["phase"], { canApply, retry }: { canApply: boolean; retry: boolean }): string {
  if (phase === "ready") return "Restart";
  if (retry) return "Retry";
  if (phase === "available" && canApply) return "Update";
  return "Check for updates";
}

/** Off's value in the select: no saved computer id takes this shape (they are `env_…`). */
export const QUICK_OFF = "__off";

/**
 * The one computer this app takes code-only updates from (docs/agents/code-only-updates.md, `code.settings.*` on this
 * window's own computer). Absent where a build cannot take them (a dev build, no base stamp) or no linked computer is
 * managed from here; main's last word about them (a fallback, a refusal) stands in for the row's line.
 */
function QuickUpdatesRow() {
  const link = registry.primary();
  const read = useHostRead(link, () => link.request<CodeSettings>("code.settings.get", {}));
  const notice = useUpdateSnapshot().notice;
  const saved = useSaved();
  const [chosen, setChosen] = useState<string | null>(null);
  const settings = read.value;
  if (!settings || settings.cannot !== null || settings.hosts.length === 0) return null;
  const options = [{ value: QUICK_OFF, label: "Off" }, ...settings.hosts.map((host) => ({ value: host.id, label: host.name }))];
  return (
    <SettingRow id="updates.quick" saved={saved} description={notice || "Small updates between releases. Each runs after a restart."}>
      <ChoiceSelect
        label="Quick updates from"
        value={chosen ?? settings.host ?? QUICK_OFF}
        options={options}
        onChange={(value) => {
          setChosen(value);
          void saved
            .run(async () => read.set(await link.request<CodeSettings>("code.settings.set", { host: value === QUICK_OFF ? null : value })))
            .then(() => setChosen(null));
        }}
      />
    </SettingRow>
  );
}

/** How far a computer's build is from master's, in a few words. */
export function versionWords(version: string | null, behind: number | null, online: boolean): string {
  if (!online && !version) return "Offline";
  const parts = [version ?? "Version not known yet"];
  if (behind === 0) parts.push("up to date");
  else if (behind !== null && behind > 0) parts.push(behind === 1 ? "one release behind" : `${behind} releases behind`);
  if (!online) parts.push("offline");
  return parts.join(", ");
}

/** Each linked computer, by its one name, with what it runs; the row opens its page at its version. */
function OtherComputers() {
  const names = useComputerNames();
  const others = useEnvironments().filter((linked) => linked.id !== LOCAL_ENVIRONMENT_ID && linked.id !== WEB_ENVIRONMENT_ID);
  if (others.length === 0) return null;
  return (
    <SettingSection of="updates.others">
      {others.map((linked) => (
        <OtherComputerRow key={linked.id} id={linked.id} name={names(linked.id).name} />
      ))}
    </SettingSection>
  );
}

function OtherComputerRow({ id, name }: { id: string; name: string }) {
  const drift = useDeployDrift(id);
  const online = useEnvironmentStatus(id).transport === "open";
  return (
    <PageRow
      title={name}
      data-computer={id}
      description={versionWords(drift.deployedVersion, drift.behind, online)}
      onOpen={() => requestSettings(computerSettingsSection(id), "pc.version")}
      openLabel={name}
    />
  );
}
