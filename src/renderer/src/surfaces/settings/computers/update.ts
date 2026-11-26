import { useEffect, useState } from "react";
import type { AdmissionState } from "@server/shared/contract-admission";
import { confirmAction } from "../../../chrome/ConfirmDialog";
import { useHostRead } from "../../../lib/connection/hostRead";
import { useDeployDrift } from "../../../lib/deployDrift";
import { deployConfirmText } from "../../../lib/hostJobCard";
import { refreshDeployStatus, startDeploy, useDeployStatuses, usePublishStatus, watchJob } from "../../../lib/hostJobs";
import { refusalWords } from "../../../lib/settingsHome";
import { useHost } from "../parts/hostRpc";

/** "2 releases behind", "Up to date": how far a computer's build is from master's, the count in digits. */
export function behindWords(behind: number | null): string | undefined {
  if (behind === null) return undefined;
  if (behind <= 0) return "Up to date";
  return `${behind} ${behind === 1 ? "release" : "releases"} behind`;
}

export type ComputerUpdate = {
  /** The version it runs, as its hello said; null until known. */
  version: string | null;
  behind: number | null;
  /** This window may update it and the computer can be updated from here: Update… is offered. */
  offered: boolean;
  /** An update runs (or this press is starting one). */
  busy: boolean;
  /** Why the computer cannot be updated from here, when its deploy tool is missing. */
  notInstalled: string | null;
  error: string | null;
  /** Update…: asks first (it restarts, its running threads pause about a minute), then starts the update. */
  update: () => Promise<void>;
};

/**
 * One computer's update, its one confirm, for every press that offers it: the computer's own page and its row on
 * Updates (docs/agents/settings.md "Updates"). Its deploy status is read while the hook is mounted and the computer is
 * in reach; an update that runs is followed.
 */
export function useComputerUpdate(environmentId: string): ComputerUpdate {
  const host = useHost(environmentId);
  const drift = useDeployDrift(environmentId);
  const deploy = useDeployStatuses()[environmentId] ?? null;
  const publish = usePublishStatus();
  const manage = host.may("host.deploy");
  // The confirm names how many threads pause: asked only while the computer is in reach.
  const admission = useHostRead<AdmissionState>(host.connected ? host.link : undefined, () => host.request<AdmissionState>("admission.get"), `${environmentId}:admission`);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!manage || !host.connected) return;
    const refresh = (): void => void refreshDeployStatus(environmentId);
    refresh();
    const timer = window.setInterval(refresh, 5_000);
    return () => window.clearInterval(timer);
  }, [environmentId, manage, host.connected]);
  useEffect(() => {
    if (deploy && (deploy.phase === "pending" || deploy.phase === "running")) watchJob(environmentId, "deploy");
  }, [deploy, environmentId]);
  const version = drift.deployedVersion ?? deploy?.version ?? null;
  const running = deploy?.phase === "pending" || deploy?.phase === "running";
  const update = async (): Promise<void> => {
    const threads = admission.value?.running ?? 0;
    const pause = threads > 0 ? ` ${threads} running ${threads === 1 ? "thread pauses" : "threads pause"} about a minute.` : "";
    const ok = await confirmAction({
      title: `Update ${host.name.name}?`,
      body: `${deployConfirmText(host.name.name, version, drift.masterVersion ?? publish?.masterVersion ?? null)}${pause}`,
      action: "Update",
      danger: true,
    });
    if (!ok) return;
    setStarting(true);
    setError(null);
    try {
      await startDeploy(environmentId, "master");
    } catch (err) {
      setError(refusalWords(err));
    } finally {
      setStarting(false);
    }
  };
  return {
    version,
    behind: drift.behind,
    offered: manage && deploy?.installed === true && host.connected,
    busy: starting || running,
    notInstalled: deploy && !deploy.installed ? `Run ${deploy.installHint} once from this Mac's checkout to update it from here` : null,
    error,
    update,
  };
}
