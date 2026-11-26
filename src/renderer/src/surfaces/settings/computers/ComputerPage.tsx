import { useEffect, useState, useSyncExternalStore } from "react";
import type { AdmissionState } from "@server/shared/contract-admission";
import type { SavedEnvironment } from "@server/shared/contract-remote";
import { PageActions, PageSection } from "../../../components/page";
import { ReadFailure } from "../parts/ReadFailure";
import { cn } from "../../../lib/cn";
import { BusyLabel, Button } from "../../../components/ui/button";
import { confirmAction } from "../../../chrome/ConfirmDialog";
import { LOCAL_ENVIRONMENT_ID, WEB_ENVIRONMENT_ID, forgetSeen, registry, useEnvironmentStatus, useLastSeenAt } from "../../../lib/connection";
import { useHostRead } from "../../../lib/connection/hostRead";
import { originText } from "../../../lib/hostConnection";
import { refreshMacBridgeHosts } from "../../../lib/macBridge";
import type { MacBridgeHostPolicy } from "@server/shared/contract-macbridge";
import { requestSettings } from "../../../lib/monaco/debugTab";
import { thisDesktopInLine } from "../../../lib/native";
import { isWebMode } from "../../../lib/nativeWeb";
import { openAddComputer } from "../../../lib/settings/addComputer";
import { computerInLine } from "../../../lib/settings/computerName";
import { openMaySheet } from "../../../lib/settings/maySheet";
import { refusalWords } from "../../../lib/settingsHome";
import { loadSavedEnvironments } from "../../../lib/tcserver/link";
import { setWorkOn, useWorkHosts } from "../../../lib/workSwitch";
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
import { behindWords, useComputerUpdate } from "./update";

export { behindWords };
import { ButtonBone, SectionRead, useComputerRead } from "./read";

/** How each computer's page's first read stands: out, failed, or answered. While it is out the title line and the
 *  version are bones; failed, they claim nothing (round 2, rules 1 and 4). A computer with no page open is absent. */
type Reach = "waiting" | "silent";
const reaches = new Map<string, Reach>();
const reachListeners = new Set<() => void>();
function markReach(environmentId: string, reach: Reach | null): void {
  if ((reaches.get(environmentId) ?? null) === reach) return;
  if (reach) reaches.set(environmentId, reach);
  else reaches.delete(environmentId);
  for (const listener of reachListeners) listener();
}
const useReach = (environmentId: string): Reach | null =>
  useSyncExternalStore(
    (listener) => {
      reachListeners.add(listener);
      return () => reachListeners.delete(listener);
    },
    () => reaches.get(environmentId) ?? null,
  );

/** A line's bone while the computer has not answered: it holds the line's place and says nothing yet. */
const LineBone = ({ width = "w-48" }: { width?: string }) => (
  <span data-slot="skeleton" aria-label="Loading" className={cn("inline-block h-3 rounded-md bg-skeleton align-middle", width)} />
);

/** The computer this page is about, as this window reaches it: the box's own page at /ui, else a linked computer. */
const servedHere = (environmentId: string): boolean => environmentId === WEB_ENVIRONMENT_ID;


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
  return lastSeen ? `Offline, last seen ${ago(lastSeen, now)}.` : "Offline.";
}

/**
 * The line under a computer's page title and its one press (SettingsView draws the title): connected, where; offline,
 * when it was last seen, with Retry; a key it no longer takes, Sign in again….
 */
export function ComputerLine({ environmentId }: { environmentId: string }) {
  const status = useEnvironmentStatus(environmentId);
  const lastSeen = useLastSeenAt(environmentId);
  const host = useHost(environmentId);
  const web = servedHere(environmentId);
  const url = registry.link(environmentId)?.transport?.url ?? registry.environment(environmentId)?.routes[status.route ?? 0]?.url;
  const reach = useReach(environmentId);
  const silent = reach === "silent";
  const words = computerLineWords({ transport: status.transport, url, lastSeen, name: host.name.name, web });
  // A key that may not change it: the page's values are words, and who can is said once, here, as a sentence.
  const managed = status.transport === "open" && !silent && !host.may("remote.settings.set", {});
  // A computer whose page got no answer: the page says so once, in its body; the line claims no connection. While its
  // first read is out, the line waits as a bone.
  if (silent && status.transport === "open") return null;
  if (reach === "waiting" && status.transport === "open") return <LineBone width="w-64" />;
  return (
    <>
      <span data-computer-line={status.transport}>{words}</span>
      {managed ? <span data-managed="">{` Its settings are changed from a computer that manages ${computerInLine(host.name)}.`}</span> : null}
      {web ? null : status.transport === "offline" || status.transport === "reconnecting" ? (
        <PageActions>
          <Button variant="ghost" size="sm" onClick={() => registry.retry(environmentId)}>
            Retry
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
export function OtherComputerPage({ environmentId, advancedOpen = false }: { environmentId: string; advancedOpen?: boolean }) {
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
  return <InReach host={host} web={web} advancedOpen={advancedOpen} />;
}

/**
 * A computer in reach. Its first read (`admission.get`, which any key may make) stands for the whole page: while it is
 * out every section stands in its shape; when it fails the page says so once with Retry and draws nothing that hangs
 * on the computer (round 1, rule 1), keeping only this Mac's own record of it.
 */
function InReach({ host, web, advancedOpen }: { host: Host; web: boolean; advancedOpen: boolean }) {
  const environmentId = host.environmentId;
  const reach = useComputerRead<AdmissionState>(host, "admission.get");
  const failed = reach.value === undefined && reach.error !== null;
  const state: Reach | null = failed ? "silent" : reach.value === undefined ? "waiting" : null;
  useEffect(() => {
    markReach(environmentId, state);
    return () => markReach(environmentId, null);
  }, [environmentId, state]);
  if (failed)
    return (
      <>
        <ReadFailure computer={environmentId} error={reach.error ?? ""} retry={reach.retry} />
        {web ? null : <OnThisMac host={host} />}
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
      <Advanced host={host} rows="pc" saysWhoCan={false} open={advancedOpen} />
      {web ? null : <OnThisMac host={host} />}
    </>
  );
}

/** Docket <version>, how far behind, Update… asking first (`useComputerUpdate`: the one confirm Updates' row uses
 *  too), and the log. While the computer has not answered its first read, the row waits as bones. */
function VersionSection({ host }: { host: Host }) {
  const id = host.environmentId;
  const up = useComputerUpdate(id);
  const waiting = useReach(id) === "waiting";
  if (!up.version && !up.notInstalled && !up.offered && !up.waiting) return null;
  return (
    <PageSection>
      <SettingRow
        id="pc.version"
        vars={{ version: waiting ? "" : (up.version ?? "") }}
        description={waiting ? <LineBone width="w-32" /> : (up.notInstalled ?? behindWords(up.behind))}
        error={up.error ?? undefined}
      >
        {waiting || up.waiting ? (
          <ButtonBone />
        ) : up.offered ? (
          <Button variant="secondary" size="sm" disabled={up.busy} onClick={() => void up.update()}>
            <BusyLabel busy={up.busy} label="Update…" />
          </Button>
        ) : null}
      </SettingRow>
      <JobLog environmentId={id} job="deploy" hostName={host.name.name} />
    </PageSection>
  );
}

/** Work's last answer from each computer, kept across launches, so an offline computer's row says what it last said
 *  and an empty cache never says Off. */
const WORK_SEEN_KEY = "docket.settings.workSeen";
function workSeen(): Record<string, boolean> {
  try {
    const parsed = JSON.parse(globalThis.localStorage?.getItem(WORK_SEEN_KEY) ?? "{}") as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, boolean>) : {};
  } catch {
    return {};
  }
}
function rememberWork(environmentId: string, enabled: boolean): void {
  const seen = workSeen();
  if (seen[environmentId] === enabled) return;
  try {
    globalThis.localStorage?.setItem(WORK_SEEN_KEY, JSON.stringify({ ...seen, [environmentId]: enabled }));
  } catch {
    // private mode / quota
  }
}

/** A host from before Work cannot answer `work.get`: it has no Work. */
const noWork = (error: string | null): boolean => !!error && /unknown method|bad request|invalid request/i.test(error);

/**
 * Whether Work is on there, opening the Work page at its switch: the switch's one home. Its own read of the computer
 * (`work.get`), so the row claims nothing before that answer: bones while it is out, the page's one line if it fails;
 * then the switch as the `work` push keeps it. Out of reach, the last answer it gave, said as such, or no state at all.
 */
function WorkRow({ environmentId }: { environmentId: string }) {
  const host = useHost(environmentId);
  const status = useEnvironmentStatus(environmentId);
  const open = status.transport === "open";
  const read = useComputerRead<{ enabled: boolean }>(host, "work.get", { skip: !open });
  const answered = read.value !== undefined ? !!read.value.enabled : noWork(read.error) ? false : null;
  const on = useWorkHosts().has(environmentId);
  useEffect(() => {
    if (answered !== null) setWorkOn(environmentId, answered);
  }, [environmentId, answered]);
  const known = open && answered !== null;
  useEffect(() => {
    if (known) rememberWork(environmentId, on);
  }, [environmentId, known, on]);
  const computer = computerInLine(host.name);
  const last = open ? null : (workSeen()[environmentId] ?? (on ? true : null));
  const description = known ? (on ? "On" : "Off") : open ? null : last === null ? undefined : `${last ? "On" : "Off"} when last seen`;
  return (
    <SettingSection of="pc.work">
      {open && !known && read.error ? (
        <ReadFailure computer={environmentId} error={read.error} retry={read.retry} />
      ) : (
        <SettingRow
          id="pc.work"
          vars={{ computer }}
          description={description === null ? <LineBone width="w-8" /> : description}
          onOpen={() => requestSettings("work", "work.on")}
          openLabel={`Work on ${computer}`}
        />
      )}
    </SettingSection>
  );
}

/** This Mac's own record of the computer: what it may do here, its name, the addresses tried, and Forget…. */
function OnThisMac({ host }: { host: Host }) {
  const id = host.environmentId;
  const local = registry.primary();
  const saved = useHostRead<SavedEnvironment[]>(local, () => local.request<SavedEnvironment[]>("remote.environments.list", {}), "saved");
  // What it may do here, read of this Mac's own server, and put where the sheet reads it once known.
  const policies = useHostRead<MacBridgeHostPolicy[]>(local, () => refreshMacBridgeHosts(), "macBridge.policy");
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
      title: `Forget ${computer}?`,
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
  // This Mac's two reads of its own record (the saved link, and what the computer may do here) stand or fall as one:
  // their rows wait in their shape, and a failure is one line naming this Mac, with one Retry.
  const record = {
    value: saved.value && policies.value ? { saved: saved.value, policies: policies.value } : undefined,
    error: saved.error ?? policies.error,
    retry: () => Promise.all([saved.retry(), policies.retry()]).then(() => undefined),
    set: () => {},
  };
  const policy = policies.value?.find((h) => h.environmentId === id);
  return (
    <SettingSection of="pc.may" vars={{ computer, mac }}>
      <SectionRead read={record} computer={LOCAL_ENVIRONMENT_ID} rows={[{ description: true, control: "none" }, { control: "field" }, { description: true, control: "none" }, { control: "button" }]}>
        {() => (
          <>
            <SettingRow
              id="pc.may"
              vars={{ computer, mac }}
              description={policy ? mayHereWords(policy) : "Nothing"}
              {...(policy ? { onOpen: () => openMaySheet(id), openLabel: `What ${computer} may do on ${mac}` } : {})}
            />
            {env ? (
              <>
                <SettingRow id="pc.name" vars={{ mac }} saved={named}>
                  <CommitField
                    aria-label={`${host.name.name}'s name on ${mac}`}
                    value={env.name}
                    className="w-64 @max-[30rem]/page:w-full"
                    onCommit={(name) =>
                      name
                        ? named.run(async () => {
                            await local.request("remote.environments.update", { id, name });
                            await changed();
                          })
                        : false
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
            {/* The record of the link, with its one act; what Forget… loses is the confirm's to say. */}
            <SettingRow id="pc.forget" vars={{ computer, mac }} error={forgetError ?? undefined}>
              <Button variant="ghost" size="sm" className="text-muted-foreground hover:text-destructive" onClick={() => void forget()}>
                Forget…
              </Button>
            </SettingRow>
          </>
        )}
      </SectionRead>
      {routes && env ? <RoutesDialog env={env} onClose={() => setRoutes(false)} onChanged={changed} /> : null}
    </SettingSection>
  );
}
