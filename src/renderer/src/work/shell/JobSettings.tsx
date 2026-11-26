import { useEffect, useMemo, useState } from "react";
import type { SectorKey, WorkDesktop, WorkspaceWorkSettings } from "@shared/work";
import type { LifeosKeyState } from "@shared/contract-work-lifeos";
import type { MacBridgeActivity } from "@shared/contract-macbridge";
import { SectorDot } from "../../chrome/WorkspaceGlyph";
import { ChoiceSelect } from "../../components/choice-select";
import { PageError, PageRow, PageRowsSkeleton, PageSection } from "../../components/page";
import { SettingSwitch } from "../../components/setting-switch";
import { BusyLabel, Button } from "../../components/ui/button";
import { LOCAL_ENVIRONMENT_ID, registry, useEnvironments } from "../../lib/connection";
import { nameInLine } from "../../lib/hostWords";
import { linkMay, useLinkMay } from "../../lib/linkMay";
import { refreshMacBridgeHosts, useMacBridgeHosts } from "../../lib/macBridge";
import { requestSettings } from "../../lib/monaco/debugTab";
import { openMaySheet } from "../../lib/settings/maySheet";
import { isWebMode } from "../../lib/nativeWeb";
import { computerInLine, useComputerNames, useOwnComputerNamed, type ComputerName as Name } from "../../lib/settings/computerName";
import { jobDesktopName, refusalWords, refusesJob, type BridgePolicy, type JobDesktop } from "../../lib/settings/jobComputers";
import { settingTitle } from "../../lib/settings/map";
import { inWords } from "../../lib/settings/workWords";
import type { WorkspaceMeta } from "../../lib/tcserver/types";
import { useWorkspaces } from "../../lib/tcserver/workspaces";
import { workErrorWords } from "../../lib/workErrorWords";
import { useWorkHosts } from "../../lib/workSwitch";
import { ComputerName } from "../../surfaces/settings/parts/ComputerName";
import { ManagedLine } from "../../surfaces/settings/parts/ManagedLine";
import { SaveMark } from "../../surfaces/settings/parts/SaveMark";
import { SettingRow, SettingSection } from "../../surfaces/settings/parts/SettingRow";
import { StartSetRow } from "../../surfaces/settings/parts/StartSetRow";
import { useSaved } from "../../surfaces/settings/parts/useSaved";
import { WaitingRows } from "../mail/WaitingSection";
import { TeamsCopyRow } from "../office/TeamsCopyRow";
import { HouseRules, VoiceRow } from "../rules/HouseRules";
import { stateOf } from "../../surfaces/settings/computers/Winvm";
import type { WinvmState } from "@shared/contract-work-winvm";
import { LifeosLine } from "../connections/LifeosLine";
import { desktopRows, hostDesktops, hostIdOfLink, linkSector, localHostId, sectorName, SECTORS, setWorkspaceSettings, workspaceSettings } from "./actions";
import { useLifeosQuery, useLifeosSession, useLifeosStatus } from "./lifeos";

/**
 * A job's page and a code workspace's job (docs/agents/settings.md "The pages: jobs, workspaces, Archive"). Settings
 * draws them from Work's chunk (`workShellChunk`), so nothing of Work loads until a page needs it.
 */

/** A failure in his words, the computer named: `workErrorWords` for a known fault, else the page's own line. */
function failureWords(err: unknown, host: string | undefined, act: string, write = false): string {
  const name = host ? nameInLine(host) : undefined;
  const Name = name ? name.charAt(0).toUpperCase() + name.slice(1) : "The computer";
  return workErrorWords(err, { host: name, write }) || `${Name} ${act}.`;
}

/** A workspace's key, as the status lists it, in one line, `host` (the workspace's computer, "The box") named; null when it is ready. */
export function keyLine(key: LifeosKeyState | undefined, host?: string | null): { line: string; failed?: boolean } | null {
  if (!key || key.state === "ready") return null;
  const where = nameInLine(host || "this computer");
  if (key.state === "waiting") return { line: `Its key is made once LifeOS is signed in on ${where}` };
  if (key.state === "elsewhere") return { line: "Its key is made on the computer that holds its add-ons" };
  return { line: key.error ?? "Its key could not be made", failed: true };
}

// ── a job's page ────────────────────────────────────────────────────

/**
 * A job's own page (`ws:<id>` of a Work workspace; the line under its title, "<Sector>, on <computer>", is
 * SettingsView's). Computers its threads may use, New threads, its Rules, Writing and mail. Its switches are the host's
 * admin rule (`work.workspace.set`): a key that may not write them reads their values as words and one line saying who
 * can, said once on the page.
 */
export function WorkWorkspacePage({ workspaceId }: { workspaceId: string }) {
  const workspace = useWorkspaces().find((w) => w.id === workspaceId);
  if (!workspace) return null;
  return <JobPage workspace={workspace} />;
}

/** The job's settings as its computer answered them, the desktops it knows and this machine's own host id: the one
 *  read the page hangs on (`useJobRead`). */
type JobRead = { settings: WorkspaceWorkSettings; far: WorkDesktop[]; localHost: string | null };

/**
 * The page's one read: the job's settings and the desktops its computer knows. While it is out every section stands
 * in its shape; refused, it is one red line with one Retry under the first heading, and the sections after it keep
 * their shape, since each would only say the same failure again.
 */
function useJobRead(workspace: WorkspaceMeta) {
  const env = workspace.environmentId;
  const [read, setRead] = useState<JobRead | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  // His Retry keeps the failed line, spinning in place, until the answer replaces it.
  const [retrying, setRetrying] = useState(false);
  useEffect(() => {
    let live = true;
    Promise.all([workspaceSettings(workspace, { fresh: true }), hostDesktops(workspace), localHostId()]).then(
      ([settings, far, localHost]) => {
        if (!live) return;
        setRead({ settings, far, localHost });
        setError(null);
        setRetrying(false);
      },
      (err: unknown) => {
        if (!live) return;
        setError(failureWords(err, registry.environment(env)?.name, "did not send this job's settings"));
        setRetrying(false);
      },
    );
    return () => {
      live = false;
    };
  }, [workspace.id, env, attempt]);
  const retry = (): void => {
    setRetrying(true);
    setAttempt((n) => n + 1);
  };
  return { read, error, retrying, retry, put: (settings: WorkspaceWorkSettings) => setRead((r) => (r ? { ...r, settings } : r)) };
}

export function JobPage({ workspace }: { workspace: WorkspaceMeta }) {
  const env = workspace.environmentId;
  const status = useLifeosStatus(env);
  const mayWrite = useLinkMay(env, "work.workspace.set");
  const mayDefaults = useLinkMay(env, "defaults.set");
  const computerLabel = useEnvironments().find((e) => e.id === env)?.name;
  const job = useJobRead(workspace);
  // This window's own computer is named by what it calls itself: its row waits for that, never a stand-in name.
  const named = useOwnComputerNamed();
  const ready = !!job.read && named;
  // A key that could not be made is said once, here: its waiting is the Writing and mail rows' state.
  const key = status?.lifeos.state === "connected" ? keyLine(status.keys.find((k) => k.workspaceId === workspace.id), computerLabel) : null;
  return (
    <>
      {key?.failed ? (
        <PageSection>
          <PageError>{key.line}</PageError>
        </PageSection>
      ) : null}
      <ComputersSection workspace={workspace} mayWrite={mayWrite} job={job} ready={ready} />
      {ready ? (
        <>
          <SettingSection of="job.threads">
            <StartSetRow id="job.threads" workspace={workspace} whose="job" may={mayDefaults} />
          </SettingSection>
          <HouseRules workspace={workspace} />
          {workspace.sector ? <WritingSection workspace={workspace} mayVoice={mayWrite} /> : null}
        </>
      ) : (
        <JobShapes workspace={workspace} mayDefaults={mayDefaults} />
      )}
    </>
  );
}

/** The sections after the first while the page's read is out or refused: each heading, its rows in their shape. */
function JobShapes({ workspace, mayDefaults }: { workspace: WorkspaceMeta; mayDefaults: boolean }) {
  const mayWaiting = useLinkMay(workspace.environmentId, "work.mail.setWaiting");
  const mayVoice = useLinkMay(workspace.environmentId, "work.workspace.set");
  return (
    <>
      <SettingSection of="job.threads">
        <PageRowsSkeleton rows={[{ description: true, control: mayDefaults ? "button" : "none" }]} />
      </SettingSection>
      <SettingSection of="job.rules">
        <PageRowsSkeleton rows={3} control="switch" />
      </SettingSection>
      {workspace.sector && (mayVoice || mayWaiting) ? (
        <SettingSection of="job.voice">
          <PageRowsSkeleton rows={[...(mayVoice ? [{ description: true, control: "switch" as const }] : []), ...(mayWaiting ? [{ control: "select" as const }, { description: true, control: "switch" as const }] : [])]} />
        </SettingSection>
      ) : null}
    </>
  );
}

/** Learn how I write, then Waiting on's two rows; each shown only to a key that may change it. */
function WritingSection({ workspace, mayVoice }: { workspace: WorkspaceMeta; mayVoice: boolean }) {
  const mayWaiting = useLinkMay(workspace.environmentId, "work.mail.setWaiting");
  if (!mayVoice && !mayWaiting) return null;
  return (
    <SettingSection of="job.voice">
      {mayVoice ? <VoiceRow workspace={workspace} /> : null}
      <WaitingRows workspace={workspace} />
    </SettingSection>
  );
}

/**
 * Every desktop its threads may use, by its one name, a switch each (`work_settings.mayUseDesktop`, host ids). Where
 * the job allows a computer that itself refuses the job's computer (its Files and commands for it are Off), an amber
 * line says which machine refuses and where that changes. Then the Windows VM and the Teams copy.
 */
function ComputersSection({ workspace, mayWrite, job, ready }: { workspace: WorkspaceMeta; mayWrite: boolean; job: ReturnType<typeof useJobRead>; ready: boolean }) {
  const env = workspace.environmentId;
  const environments = useEnvironments();
  const names = useComputerNames();
  const settings = ready ? (job.read?.settings ?? null) : null;
  const far = job.read?.far ?? [];
  const localHost = job.read?.localHost ?? null;
  const error = job.error;
  const setSettings = job.put;
  const desktops = desktopRows(environments, far, localHost);
  const jobComputer = names(env);
  const jobHost = hostIdOfLink(env, localHost);
  const refusing = useRefusingComputers(desktops, jobHost);
  /** The desktops it may use other than its own computer: where a Teams file lies that a copy would bring here. */
  const others = settings ? settings.mayUseDesktop.filter((id) => id !== env && id !== jobHost) : [];
  // The list holds host ids; this machine's link is "local" in the window, its host id on every host. Each press is
  // made from what the host last answered, so a refusal leaves the list as it was.
  const allow = async (desktop: JobDesktop, next: boolean): Promise<void> => {
    const current = await workspaceSettings(workspace, { fresh: true });
    const kept = current.mayUseDesktop.filter((id) => id !== desktop.host && id !== desktop.link);
    setSettings(await setWorkspaceSettings(workspace, { mayUseDesktop: next ? [...kept, desktop.host] : kept }));
  };
  return (
    <SettingSection of="job.computers">
      {settings
        ? desktops.map((desktop) => {
            const name = jobDesktopName(desktop, names);
            const on = allowedIn(settings, desktop);
            return (
              <DesktopRow
                key={desktop.host}
                desktop={desktop}
                name={name}
                on={on}
                may={mayWrite}
                refusal={on && refusing.has(desktop.host) ? refusalWords(name, computerInLine(jobComputer)) : null}
                jobHost={env}
                onChange={(next) => inWords(env, () => allow(desktop, next))}
              />
            );
          })
        : error
          ? null
          : // Its desktops, then the Windows VM's and the Teams copy's rows where it has them: the shape that lands.
            <PageRowsSkeleton rows={[...desktops.map(() => ({ control: "switch" as const })), { control: "switch" as const }]} />}
      {settings ? (
        <JobVmRow
          env={env}
          on={!!settings.windowsVm}
          may={mayWrite}
          onChange={(next) => inWords(env, async () => void setSettings(await setWorkspaceSettings(workspace, { windowsVm: next })))}
        />
      ) : null}
      {settings && mayWrite && others.length ? <TeamsCopyRow workspace={workspace} computer={computerInLine(jobComputer)} /> : null}
      {error ? (
        <PageError
          action={
            <Button variant="ghost" size="sm" disabled={job.retrying} onClick={job.retry}>
              <BusyLabel busy={job.retrying} label="Retry" />
            </Button>
          }
        >
          {error}
        </PageError>
      ) : null}
      {mayWrite ? null : <ManagedLine computer={jobComputer.name} />}
    </SettingSection>
  );
}

/** Whether the job's list holds a desktop, by its host id or, for one this window links, its link's. */
function allowedIn(settings: WorkspaceWorkSettings, d: JobDesktop): boolean {
  return [d.host, d.link].some((id) => settings.mayUseDesktop.includes(id));
}

/** One desktop: its name, the switch, and where that computer refuses the job's computer, the line that says so. */
function DesktopRow({
  desktop,
  name,
  on,
  may,
  refusal,
  jobHost,
  onChange,
}: {
  desktop: JobDesktop;
  name: Name;
  on: boolean;
  may: boolean;
  refusal: string | null;
  /** The job's own computer, as this window links it: the one this Mac's rule is about. */
  jobHost: string;
  onChange: (next: boolean) => Promise<void>;
}) {
  const saved = useSaved();
  const description = refusal ? (
    // Two permissions disagree: the job's (this switch) and the computer's own. The first line is the switch's, the
    // second the computer's refusal with where it changes, said together.
    <>
      <span className="block">Allowed for this job</span>
      <span data-refusal className="block text-warning">
      {refusal}
      {/* This Mac's own refusal changes here, in Sharing; another computer's only on that computer. */}
      {name.own ? " " : null}
      {name.own ? (
        <Button
          variant="ghost"
          size="xs"
          className="h-auto px-0 align-baseline text-xs font-medium text-foreground underline underline-offset-2"
          onClick={() => {
            // Sharing, with what the job's computer may do on this Mac open over it: the rule that refuses.
            requestSettings("sharing", "sharing.may");
            openMaySheet(jobHost);
          }}
        >
          Open Sharing
        </Button>
      ) : null}
      </span>
    </>
  ) : may ? undefined : on ? "Allowed" : "Not allowed";
  return (
    <PageRow data-computer={desktop.host} title={<ComputerName computer={name} />} description={description} error={saved.error ?? undefined}>
      {may ? (
        <>
          <SaveMark state={saved.state} />
          <SettingSwitch label={name.name} on={on} onChange={(next) => saved.run(() => onChange(next))} />
        </>
      ) : null}
    </PageRow>
  );
}

/**
 * Which of the job's desktops refuse its computer, as far as this window can read: this Mac's own bridge policy, and
 * each other linked computer's activity where this key may read it. A computer this window has no link to says nothing.
 */
function useRefusingComputers(desktops: readonly JobDesktop[], jobHost: string): Set<string> {
  const own = useMacBridgeHosts();
  const [others, setOthers] = useState<Map<string, BridgePolicy[]>>(new Map());
  const linked = desktops.filter((d) => d.link !== LOCAL_ENVIRONMENT_ID && registry.has(d.link)).map((d) => d.link);
  const linkedKey = linked.join(",");
  const desktop = !isWebMode() && !!registry.link(LOCAL_ENVIRONMENT_ID);
  useEffect(() => {
    if (desktop) void refreshMacBridgeHosts().catch(() => {});
  }, [desktop]);
  useEffect(() => {
    let live = true;
    for (const id of linkedKey ? linkedKey.split(",") : []) {
      const link = registry.link(id);
      if (!link || !linkMay(id, "macBridge.activity")) continue;
      link.request<MacBridgeActivity>("macBridge.activity", {}).then(
        (activity) => live && setOthers((map) => new Map(map).set(id, activity.hosts)),
        () => {},
      );
    }
    return () => {
      live = false;
    };
  }, [linkedKey]);
  return useMemo(() => {
    const refusing = new Set<string>();
    for (const d of desktops) {
      const policies = d.link === LOCAL_ENVIRONMENT_ID ? (desktop ? own : null) : others.get(d.link);
      if (d.host !== jobHost && refusesJob(policies, jobHost)) refusing.add(d.host);
    }
    return refusing;
  }, [desktops, own, others, jobHost, desktop]);
}

/** The Windows VM's switch, shown only where the job's computer has one set up: its threads get the `windows_*` tools. */
function JobVmRow({ env, on, may, onChange }: { env: string; on: boolean; may: boolean; onChange: (next: boolean) => Promise<void> }) {
  const [state, setState] = useState<WinvmState | null>(null);
  const saved = useSaved();
  useEffect(() => {
    const link = registry.linkOf(env);
    void link.request<WinvmState>("work.winvm.state", {}).then(stateOf).then(setState, () => setState(null));
    return link.onPush((push) => push.push === "work.winvm" && setState(push.state as WinvmState));
  }, [env]);
  if (!state || state.cannot || state.state === "none") return null;
  return (
    <SettingRow id="job.vm" saved={may ? saved : undefined} description={may ? undefined : on ? "Allowed" : "Not allowed"}>
      {may ? <SettingSwitch label={settingTitle("job.vm")} on={on} onChange={(next) => saved.run(() => onChange(next))} /> : null}
    </SettingRow>
  );
}

// ── a code workspace's job ──────────────────────────────────────────

/**
 * A code workspace's job (`ws.job`, shown while Work is on for its computer): the LifeOS job its threads may read and
 * draft in. It saves with the mark and goes back on a refusal. Linking needs a key that manages the computer: another
 * key reads the job as words, with who can change it. Signed out of LifeOS with no job linked, the section says so with
 * its press (`LifeosLine`).
 */
export function CodeWorkspaceSector({ workspaceId }: { workspaceId: string }) {
  const workspace = useWorkspaces().find((w) => w.id === workspaceId);
  const on = useWorkHosts();
  if (!workspace || workspace.kind === "work" || !on.has(workspace.environmentId)) return null;
  return <ItsJob workspace={workspace} />;
}

function ItsJob({ workspace }: { workspace: WorkspaceMeta }) {
  const env = workspace.environmentId;
  const status = useLifeosStatus(env);
  const session = useLifeosSession(env, null);
  const listed = useLifeosQuery<{ key: string; label: string }[]>(session, "sectors:list", {});
  const labels = useMemo(() => new Map(listed.status === "ready" ? listed.value.map((s) => [s.key, s.label] as const) : []), [listed]);
  const saved = useSaved();
  const [picked, setPicked] = useState<string | null>(null);
  const mayLink = useLinkMay(env, "work.lifeos.link");
  const computer = useComputerNames()(env);
  const sector = workspace.sector ?? null;
  const media = <SectorDot sector={(picked === null ? sector : picked === "none" ? null : picked) ?? null} />;
  if (!mayLink) {
    return (
      <SettingSection of="ws.job">
        <SettingRow id="ws.job" media={media} description={sector ? sectorName(sector, labels) : "None"} />
        <ManagedLine computer={computer.name} />
      </SettingSection>
    );
  }
  const connected = status?.lifeos.state === "connected";
  const key = sector ? keyLine(status?.keys.find((k) => k.workspaceId === workspace.id), computer.name) : null;
  return (
    <SettingSection of="ws.job">
      {connected || sector ? (
        <SettingRow id="ws.job" media={media} saved={saved} description={key && !key.failed ? key.line : "Its threads can read and draft in that job"} error={key?.failed ? key.line : undefined}>
          <ChoiceSelect
            size="sm"
            label={settingTitle("ws.job")}
            value={picked ?? sector ?? "none"}
            options={[{ value: "none", label: "None" }, ...SECTORS.map((s) => ({ value: s, label: sectorName(s, labels) }))]}
            onChange={(next) => {
              setPicked(next);
              void saved.run(() => inWords(env, () => linkSector(workspace, next === "none" ? null : (next as SectorKey)))).then(() => setPicked(null));
            }}
          />
        </SettingRow>
      ) : (
        <LifeosLine session={session} waiting={<PageRowsSkeleton rows={[{ description: true, media: true, control: "select" }]} />} />
      )}
    </SettingSection>
  );
}
