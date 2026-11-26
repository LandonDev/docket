import { useEffect, useState } from "react";
import type { AdmissionState } from "@server/shared/contract-admission";
import type { SavedEnvironment } from "@server/shared/contract-remote";
import { PageActions, PageRowsSkeleton, PageSection } from "../../../components/page";
import { BusyLabel, Button } from "../../../components/ui/button";
import { confirmAction } from "../../../chrome/ConfirmDialog";
import { LOCAL_ENVIRONMENT_ID, WEB_ENVIRONMENT_ID, forgetSeen, registry, useEnvironmentStatus, useLastSeenAt } from "../../../lib/connection";
import { useHostRead } from "../../../lib/connection/hostRead";
import { useDeployDrift } from "../../../lib/deployDrift";
import { originText } from "../../../lib/hostConnection";
import { managedElsewhere } from "../../../lib/linkMay";
import { deployConfirmText } from "../../../lib/hostJobCard";
import { refreshDeployStatus, startDeploy, useDeployStatuses, usePublishStatus, watchJob } from "../../../lib/hostJobs";
import { useMacBridgeHosts } from "../../../lib/macBridge";
import { requestSettings } from "../../../lib/monaco/debugTab";
import { thisDesktopInLine } from "../../../lib/native";
import { isWebMode } from "../../../lib/nativeWeb";
import { openAddComputer } from "../../../lib/settings/addComputer";
import { computerInLine } from "../../../lib/settings/computerName";
import { openMaySheet } from "../../../lib/settings/maySheet";
import { refusalWords } from "../../../lib/settingsHome";
import { loadSavedEnvironments } from "../../../lib/tcserver/link";
import { useWorkHosts } from "../../../lib/workSwitch";
import { environment as environmentSelection } from "../../../stores/environment";
import { ago } from "../../harnessLine";
import { CommitField } from "../hosts/CommitField";
import { RoutesDialog } from "../hosts/dialogs/RoutesDialog";
import { JobLog } from "./JobLog";
import { useHost, type Host } from "../parts/hostRpc";
import { SettingRow, SettingSection } from "../parts/SettingRow";
import { useSaved } from "../parts/useSaved";
import { Advanced } from "./Advanced";
import { AgentApps } from "./AgentApps";
import { mayHereWords } from "./MaySheet";
import { SetUpHere } from "./SetUpHere";
import { SignIns } from "./SignIns";
import { ThreadsRows } from "./ThreadsRows";

/** The computer this page is about, as this window reaches it: the box's own page at /ui, else a linked computer. */
const servedHere = (environmentId: string): boolean => environmentId === WEB_ENVIRONMENT_ID;

/** "Two releases behind", "Up to date": how far a computer's build is from master's. */
export function behindWords(behind: number | null): string | undefined {
  if (behind === null) return undefined;
  if (behind <= 0) return "Up to date";
  const words = ["One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine"];
  return `${words[behind - 1] ?? behind} ${behind === 1 ? "release" : "releases"} behind`;
}

/** The line under a computer's title: how this window reaches it, in the house's words. */
export function computerLineWords({
  transport,
  url,
  lastSeen,
  name,
  web,
  now = Date.now(),
}: {
  transport: string;
  url: string | undefined;
  lastSeen: number | null;
  name: string;
  web: boolean;
  now?: number;
}): string {
  if (web) return "This page is served from it.";
  // The socket's address as he would type it: its host, without the socket's own path.
  const where = url ? originText(url).replace(/\/ws$/, "") : null;
  if (transport === "open") return where ? `Connected at ${where}.` : "Connected.";
  if (transport === "connecting") return "Connecting…";
  if (transport === "unauthorized") return `${name} no longer lets ${thisDesktopInLine()} in.`;
  return lastSeen ? `Offline, last seen ${ago(lastSeen, now)}` : "Offline";
}

/**
 * The line under a computer's page title and its one press (SettingsView draws the title): connected, where; offline,
 * when it was last seen, with Try again; a key it no longer takes, Sign in again….
 */
export function ComputerLine({ environmentId }: { environmentId: string }) {
  const status = useEnvironmentStatus(environmentId);
  const lastSeen = useLastSeenAt(environmentId);
  const host = useHost(environmentId);
  const web = servedHere(environmentId);
  const url = registry.link(environmentId)?.transport?.url ?? registry.environment(environmentId)?.routes[status.route ?? 0]?.url;
  const words = computerLineWords({ transport: status.transport, url, lastSeen, name: host.name.name, web });
  // A key that may not change it: the page's values are words, and who can is said once, here.
  const managed = status.transport === "open" && !host.may("remote.settings.set", {});
  return (
    <>
      <span data-computer-line={status.transport}>{words}</span>
      {managed ? <span data-managed=""> {managedElsewhere(host.name.name)}.</span> : null}
      {web ? null : status.transport === "offline" || status.transport === "reconnecting" ? (
        <PageActions>
          <Button variant="ghost" size="sm" onClick={() => registry.retry(environmentId)}>
            Try again
          </Button>
        </PageActions>
      ) : status.transport === "unauthorized" ? (
        <PageActions>
          <Button variant="ghost" size="sm" onClick={() => openAddComputer({ way: "link", computer: environmentId })}>
            Sign in again…
          </Button>
        </PageActions>
      ) : null}
    </>
  );
}

/**
 * Another computer's page (docs/agents/settings.md "The pages: computers"): every row changes that computer, asked
 * over its own link, but for the last section, On this Mac, which is this Mac's own record of it. Each section reads
 * on its own, so a key that may only read sees what it may and the rest as words, never a page that fails whole; a
 * computer out of reach shows what this Mac knows of it (its version, Work, On this Mac) and asks it nothing. At
 * /ui the one computer is the one serving the page: its sign-ins and Advanced, and no On this Mac.
 */
export function OtherComputerPage({ environmentId }: { environmentId: string }) {
  const host = useHost(environmentId);
  const web = isWebMode();
  const transport = useEnvironmentStatus(environmentId).transport;
  // Out of reach (offline, or a key it no longer takes): what this Mac knows of it, and nothing that would wait on it.
  const away = !web && (transport === "offline" || transport === "reconnecting" || transport === "unauthorized");
  if (away)
    return (
      <>
        <VersionSection host={host} />
        <WorkRow environmentId={environmentId} />
        <OnThisMac host={host} />
      </>
    );
  return (
    <>
      {web ? null : <VersionSection host={host} />}
      <ThreadsRows host={host} rows="pc" saysWhoCan={false} />
      <AgentApps host={host} rows="pc" />
      <SignIns host={host} rows="pc" saysWhoCan={false} />
      <WorkRow environmentId={environmentId} />
      {web ? null : <SetUpHere environmentId={environmentId} />}
      <Advanced host={host} rows="pc" saysWhoCan={false} />
      {web ? null : <OnThisMac host={host} />}
    </>
  );
}

/** Docket <version>, how far behind, Update… asking first (it restarts; its running threads pause), and the log. */
function VersionSection({ host }: { host: Host }) {
  const id = host.environmentId;
  const drift = useDeployDrift(id);
  const deploy = useDeployStatuses()[id] ?? null;
  const publish = usePublishStatus();
  const manage = host.may("host.deploy");
  // Asked only while the computer is in reach: an Update… waits for it anyway.
  const admission = useHostRead<AdmissionState>(host.connected ? host.link : undefined, () => host.request<AdmissionState>("admission.get"), `${id}:admission`);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!manage || !host.connected) return;
    const refresh = (): void => void refreshDeployStatus(id);
    refresh();
    const timer = window.setInterval(refresh, 5_000);
    return () => window.clearInterval(timer);
  }, [id, manage, host.connected]);
  useEffect(() => {
    if (deploy && (deploy.phase === "pending" || deploy.phase === "running")) watchJob(id, "deploy");
  }, [deploy, id]);
  const version = drift.deployedVersion ?? deploy?.version ?? null;
  if (!version && !deploy) return null;
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
    setBusy(true);
    setError(null);
    try {
      await startDeploy(id, "master");
    } catch (err) {
      setError(refusalWords(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <PageSection>
      <SettingRow
        id="pc.version"
        vars={{ version: version ?? "" }}
        description={deploy && !deploy.installed ? `Run ${deploy.installHint} once from this Mac's checkout to update it from here` : behindWords(drift.behind)}
        error={error ?? undefined}
      >
        {manage && deploy?.installed ? (
          <Button variant="secondary" size="sm" disabled={busy || running || !host.connected} onClick={() => void update()}>
            <BusyLabel busy={busy || running} label="Update…" />
          </Button>
        ) : null}
      </SettingRow>
      <JobLog environmentId={id} job="deploy" hostName={host.name.name} />
    </PageSection>
  );
}

/** Whether Work is on there, opening the Work page at its switch: the switch's one home. */
function WorkRow({ environmentId }: { environmentId: string }) {
  const on = useWorkHosts().has(environmentId);
  return (
    <PageSection>
      <SettingRow id="pc.work" description={on ? "On" : "Off"} onOpen={() => requestSettings("work", "work.on")} openLabel="Work" />
    </PageSection>
  );
}

/** This Mac's own record of the computer: what it may do here, its name, the addresses tried, and Forget…. */
function OnThisMac({ host }: { host: Host }) {
  const id = host.environmentId;
  const local = registry.primary();
  const saved = useHostRead<SavedEnvironment[]>(local, () => local.request<SavedEnvironment[]>("remote.environments.list", {}), "saved");
  const bridge = useMacBridgeHosts().find((h) => h.environmentId === id);
  const env = saved.value?.find((e) => e.id === id);
  const named = useSaved();
  const [routes, setRoutes] = useState(false);
  const [forgetError, setForgetError] = useState<string | null>(null);
  const computer = computerInLine(host.name);
  const mac = thisDesktopInLine();
  if (id === LOCAL_ENVIRONMENT_ID) return null;
  const changed = async (): Promise<void> => {
    await saved.retry();
    await loadSavedEnvironments();
  };
  const forget = async (): Promise<void> => {
    const ok = await confirmAction({
      title: `Forget ${host.name.name}?`,
      body: `${mac.charAt(0).toUpperCase()}${mac.slice(1)} drops its link. ${host.name.name} still lets ${mac} in until you remove it there.`,
      action: "Forget",
      danger: true,
    });
    if (!ok) return;
    setForgetError(null);
    try {
      await local.request("remote.environments.remove", { id });
      environmentSelection.forget(id);
      forgetSeen(id);
      await loadSavedEnvironments();
    } catch (err) {
      setForgetError(refusalWords(err));
    }
  };
  return (
    <SettingSection of="pc.may" vars={{ computer, mac }}>
      <SettingRow
        id="pc.may"
        vars={{ computer, mac }}
        description={bridge ? mayHereWords(bridge) : "Nothing"}
        onOpen={() => openMaySheet(id)}
        openLabel={`What ${host.name.name} may do on ${mac}`}
      />
      {/* This Mac's own record, read once: its two rows wait in their shape. */}
      {!saved.value && !saved.error ? <PageRowsSkeleton rows={[{ control: "field" }, { description: true, control: "none" }]} /> : null}
      {env ? (
        <>
          <SettingRow id="pc.name" vars={{ mac }} saved={named}>
            <CommitField
              aria-label={`${host.name.name}'s name on ${mac}`}
              value={env.name}
              className="w-64 @max-[30rem]/page:w-full"
              onCommit={(name) =>
                name ? named.run(async () => {
                  await local.request("remote.environments.update", { id, name });
                  await changed();
                }) : false
              }
            />
          </SettingRow>
          <SettingRow
            id="pc.addresses"
            vars={{ mac }}
            description={env.routes.map((route) => originText(route.url)).join(", then ") || "None"}
            onOpen={() => setRoutes(true)}
            openLabel={`Addresses ${mac} tries`}
          />
        </>
      ) : null}
      <SettingRow
        id="pc.forget"
        vars={{ computer, mac }}
        description={`${mac.charAt(0).toUpperCase()}${mac.slice(1)} drops its link. ${host.name.name} still lets ${mac} in until you remove it there.`}
        error={forgetError ?? undefined}
      >
        <Button variant="ghost" size="sm" className="text-muted-foreground hover:text-destructive" onClick={() => void forget()}>
          Forget…
        </Button>
      </SettingRow>
      {routes && env ? <RoutesDialog env={env} onClose={() => setRoutes(false)} onChanged={changed} /> : null}
    </SettingSection>
  );
}
