import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import type { SectorKey, WorkDesktop, WorkspaceWorkSettings } from "@shared/work";
import type { LifeosKeyState, LifeosState, LifeosStatus } from "@shared/contract-work-lifeos";
import { SectorDot } from "../../chrome/WorkspaceGlyph";
import { ThreadDefaultsEditor } from "../../chrome/ThreadDefaultsDialog";
import { ModalBody, ModalPanel, useClosingDialog } from "../../chrome/Modal";
import { Field } from "../../chrome/DialogField";
import { DialogFooter, ErrorLine } from "../../chrome/ConfirmDialog";
import { ChoiceSelect } from "../../components/choice-select";
import { PageEmpty, PageError, PageRow, PageRowsSkeleton, PageSection } from "../../components/page";
import { Skeleton } from "../../components/ui/skeleton";
import { SettingSwitch } from "../../components/setting-switch";
import { BusyLabel, Button } from "../../components/ui/button";
import { Dialog } from "../../components/ui/dialog";
import { Input } from "../../components/ui/input";
import { LOCAL_ENVIRONMENT_ID, registry, useEnvironments } from "../../lib/connection";
import { nameInLine } from "../../lib/hostWords";
import { defineChunk } from "../../lib/lazyChunk";
import { managedElsewhere, useLinkMay } from "../../lib/linkMay";
import { requestSettings } from "../../lib/monaco/debugTab";
import type { WorkspaceMeta } from "../../lib/tcserver/types";
import { useWorkspaces } from "../../lib/tcserver/workspaces";
import { workErrorWords } from "../../lib/workErrorWords";
import { useWorkHosts } from "../../lib/workSwitch";
import { workDigestChunk } from "../../surfaces/chunks";
import { TeamsCopyRow } from "../office/TeamsCopyRow";
import { TeamsFilesRow } from "../office/TeamsFilesRow";
import { GuestLinksSection } from "../guests/GuestLinksSection";
import { WinvmSection, WinvmWorkspaceRow } from "../winvm/WinvmSection";
import { HouseRules } from "../rules/HouseRules";
import { LifeosLine } from "../connections/LifeosLine";
import { useAgainKept, type AgainKept } from "./againKept";
import { captureKeyApi, CaptureKeyRow } from "../capture/CaptureKeyRow";
import { WaitingSection } from "../mail/WaitingSection";
import { StartPlacesSection } from "../clashes/StartPlaces";
import { desktopRows, hostDesktops, hostIdOfLink, isDesktop, linkIdOfHost, linkSector, localHostId, sectorName, SECTORS, setWorkHome, setWorkspaceSettings, workHome, workspaceSettings } from "./actions";
import { lifeosHostName, sessionFailure, useLifeosQuery, useLifeosSession, useLifeosStatus } from "./lifeos";

/**
 * A failure on these pages in his words, naming the computer: `workErrorWords` for a known fault, else the
 * page's own line for the act ("The box did not save the change."), never the link's text.
 */
function failureWords(err: unknown, host: string | undefined, act: string, write = false): string {
  const name = host ? nameInLine(host) : undefined;
  const Host = name ? name.charAt(0).toUpperCase() + name.slice(1) : "The host";
  return workErrorWords(err, { host: name, write }) || `${Host} ${act}.`;
}

/** A link's name as the rail gives it, or nothing for a host this window does not know. */
const hostOf = (environmentId: string): string | undefined => registry.environment(environmentId)?.name;

/**
 * Settings → Work while Work is on (prototype settings.html, "One Work
 * page"): the sectors LifeOS has, the model Work threads start on, where
 * Work runs, and every guest link (milestone 31). Each host's LifeOS
 * sign-in and its tools are on Connections (work/connections), so no
 * fact is said on both pages. A Work workspace's
 * own page holds what is its own. Grants join this page with the Outbox
 * (milestone 14).
 */

export function WorkSettingsBody() {
  const environments = useEnvironments();
  const on = useWorkHosts();
  const hosts = environments.filter((e) => on.has(e.id));
  const [home, setHome] = useState(() => workHome(environments));
  const keyApi = useMemo(captureKeyApi, []);
  return (
    <>
      {/* Each host's sign-in is on Connections; the sectors it reads are a fact of LifeOS, said once here. */}
      {home ? <SectorsSection environmentId={home} /> : null}
      {keyApi && on.has(LOCAL_ENVIRONMENT_ID) ? (
        <PageSection title="Capture">
          <CaptureKeyRow api={keyApi} />
        </PageSection>
      ) : null}
      <DigestSection />
      <PageSection title="Models">
        <PageRow title="Work threads" description="Same as code threads" onOpen={() => requestSettings("defaults")} openLabel="Thread defaults" />
      </PageSection>
      {hosts.length > 1 ? (
        <PageSection title="Where it runs">
          <PageRow title="New Work workspaces are made on">
            <ChoiceSelect
              size="sm"
              label="New Work workspaces are made on"
              value={home ?? hosts[0]!.id}
              options={hosts.map((h) => ({ value: h.id, label: h.name }))}
              onChange={(id) => {
                setWorkHome(id);
                setHome(id);
              }}
            />
          </PageRow>
        </PageSection>
      ) : null}
      {/* A section a host, as the Windows VM's are: a second host's heading never reads as one more folder. */}
      {hosts
        .filter((host) => isDesktop(host.platform) || host.id === LOCAL_ENVIRONMENT_ID)
        .map((host) => (
          <TeamsFilesRow key={host.id} link={registry.linkOf(host.id)} host={host.name} title={hosts.length > 1 ? `Folders on ${nameInLine(host.name)}` : "Folders"} editable={host.id === LOCAL_ENVIRONMENT_ID} />
        ))}
      {home ? <StartPlacesSection environmentId={home} /> : null}
      <WinvmSection hosts={hosts.map((h) => h.id)} />
      <GuestLinksSection hosts={hosts.map((h) => h.id)} />
      {home ? <MailSettingsSection environmentId={home} /> : null}
    </>
  );
}

/** The digest's settings (work/digest), in the digest's own chunk. */
const DigestSection = workDigestChunk.surface("SettingsSection", <PageRowsSkeleton rows={[{ control: "number" }, { control: "select" }, { control: "select" }, { control: "select" }, { control: "select" }]} />);

/** Mail's settings, in a chunk of their own: the mail client loads only when Settings shows them. */
const mailSettingsChunk = defineChunk("work-mail-settings", () => import("../mail/MailSettingsSection"));
const MailSettingsSection = mailSettingsChunk.surface("Section", (
  <PageSection title="Mail">
    <PageRowsSkeleton rows={3} />
  </PageSection>
));

/**
 * The sectors LifeOS has, each with its dot: what this host's Work threads can be linked to. Signed out, nothing:
 * Connections holds the sign-in. A read that failed under a connected status says so with Retry, which reads it again,
 * the line kept with Retry spinning until the answer replaces it.
 */
function SectorsSection({ environmentId }: { environmentId: string }) {
  const again = useAgainKept();
  return <SectorsRead key={again.attempt} environmentId={environmentId} again={again} />;
}

function SectorsRead({ environmentId, again }: { environmentId: string; again: AgainKept }) {
  const session = useLifeosSession(environmentId, null);
  const listed = useLifeosQuery<{ key: string; label: string; order: number }[]>(session, "sectors:list", {});
  const loading = listed.status === "loading";
  const { settle } = again;
  useEffect(() => void (loading || settle()), [loading, settle]);
  if (session.state !== "connected") return null;
  const retrying = loading && again.retrying;
  const failed = listed.status === "failed" || retrying;
  return (
    <PageSection title="LifeOS">
      {failed ? (
        <PageError
          action={
            <Button variant="ghost" size="sm" disabled={retrying} onClick={again.retry}>
              <BusyLabel busy={retrying} label="Retry" />
            </Button>
          }
        >
          {sessionFailure("unreachable", false, lifeosHostName(environmentId))}
        </PageError>
      ) : listed.status === "loading" ? (
        <PageRowsSkeleton rows={1} description control="none" />
      ) : (
        <SectorsRow sectors={listed.value} />
      )}
    </PageSection>
  );
}

function SectorsRow({ sectors }: { sectors: { key: string; label: string; order: number }[] }) {
  return (
    <PageRow
      title="Sectors"
      description={
        <span className="flex flex-wrap gap-x-3 gap-y-1">
          {[...sectors]
            .sort((a, b) => a.order - b.order)
            .map((sector) => (
              <span key={sector.key} className="inline-flex items-center gap-1">
                <SectorDot sector={sector.key} className="size-3" />
                {sector.label}
              </span>
            ))}
        </span>
      }
    />
  );
}

/**
 * Sign in by pairing (the host polls for its token itself), or, on this
 * window's own host alone, with a device token made in LifeOS (`auth:mint`):
 * `work.lifeos.setToken` is local-only. The code is shown only to this window, an admin.
 */
export function SignInDialog({ environmentId, state, onClose }: { environmentId: string; state: LifeosState; onClose: () => void }) {
  const link = registry.linkOf(environmentId);
  // A token is pasted only into this window's own host: another host takes it over a remote link never, and /ui's
  // own link is a key's (`work.lifeos.setToken` is local-only), so the host's rule is asked too.
  const mayToken = useLinkMay(environmentId, "work.lifeos.setToken");
  const local = environmentId === registry.primaryEnvironmentId && mayToken;
  const [code, setCode] = useState<{ code: string; expiresAt: number } | null>(
    state.state === "pairing" && state.code ? { code: state.code, expiresAt: state.expiresAt } : null,
  );
  const [token, setToken] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The code's ask that failed takes the bones' place, with Retry asking the same computer again.
  const [codeError, setCodeError] = useState<string | null>(null);
  // A press that asks again (Retry, New code) is out: the row it was pressed on stays, the press spinning in place,
  // until the new code or the new cause replaces it.
  const [asking, setAsking] = useState(false);
  const mounted = useRef(true);
  const { root, closeThen } = useClosingDialog(onClose, pending);
  const [now, setNow] = useState(() => Date.now());

  const ask = (): Promise<void> =>
    link.request<{ code: string; expiresAt: number }>("work.lifeos.pairStart", {}).then(
      (answer) => {
        if (!mounted.current) return;
        setCode(answer);
        setCodeError(null);
      },
      (err: unknown) => {
        if (!mounted.current) return;
        // The host's silence by the rule's words ("The box did not answer"); any other cause in Work's.
        const silent = err instanceof Error && (err.name === "TimeoutError" || err.name === "ConnectionLostError");
        setCodeError(silent ? sessionFailure("unanswered", false, hostOf(environmentId)) : failureWords(err, hostOf(environmentId), "did not start the sign-in"));
      },
    );
  const askAgain = (): void => {
    setAsking(true);
    void ask().finally(() => mounted.current && setAsking(false));
  };
  // The first ask, under the code's bone.
  useEffect(() => {
    mounted.current = true;
    if (!code) void ask();
    return () => {
      mounted.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once a dialog: a later ask is his press
  }, []);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  // The host finishes the pairing by itself: the status push closes the dialog.
  useEffect(() => {
    if (state.state === "connected") closeThen(onClose);
  }, [closeThen, onClose, state.state]);

  const cancel = (): void => {
    void link.request("work.lifeos.pairCancel", {}).catch(() => {});
    closeThen(onClose);
  };
  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (!token.trim() || pending) return;
    setPending(true);
    setError(null);
    try {
      await link.request<LifeosStatus>("work.lifeos.setToken", { token: token.trim() });
      setPending(false);
      closeThen(onClose);
    } catch (err) {
      setError(failureWords(err, hostOf(environmentId), "did not take the token", true));
      setPending(false);
    }
  };
  const left = code ? Math.max(0, Math.ceil((code.expiresAt - now) / 1000)) : 0;

  return (
    <Dialog {...root}>
      <ModalPanel onClose={cancel} busy={pending} title="Sign in to LifeOS" description="Approve this code in LifeOS, under Approve a sign-in." size="sm">
        <form onSubmit={(event) => void submit(event)}>
          <ModalBody>
            <div className="flex items-baseline justify-between gap-3">
              {code ? (
                <span className="font-mono text-base font-medium leading-6 text-foreground tabular-nums">{code.code}</span>
              ) : codeError ? (
                // Bones are for an ask that is out: a failed one says so in the code's place, with Retry.
                <p role="alert" data-code-failed className="min-w-0 text-xs leading-6 text-pretty text-destructive">
                  {codeError}
                </p>
              ) : (
                // The code's own 24px line, a bone its width: nothing moves when it lands.
                <div role="status" aria-label="Asking for a code" data-code-bone className="flex h-6 items-center">
                  <Skeleton className="h-4 w-24" />
                </div>
              )}
              {code && left > 0 ? (
                <span className="text-xs text-muted-foreground tabular-nums">{`${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`}</span>
              ) : code ? (
                // A code past its life asks the same computer for a new one, in the timer's place (the ask's effect).
                <Button variant="ghost" size="xs" className="-me-2 shrink-0" disabled={asking} onClick={askAgain}>
                  <BusyLabel busy={asking} label="New code" align="end" />
                </Button>
              ) : codeError ? (
                <Button variant="ghost" size="xs" className="-me-2 shrink-0" disabled={asking} onClick={askAgain}>
                  <BusyLabel busy={asking} label="Retry" align="end" />
                </Button>
              ) : null}
            </div>
            {local ? (
              <Field label="Or a device token">
                <Input value={token} onChange={(event) => setToken(event.target.value)} placeholder="lo_…" spellCheck={false} autoComplete="off" />
              </Field>
            ) : null}
            <ErrorLine error={error} />
          </ModalBody>
          <DialogFooter onCancel={cancel} confirmLabel={local ? "Sign in" : undefined} pending={pending} disabled={!token.trim()} />
        </form>
      </ModalPanel>
    </Dialog>
  );
}

// ── a workspace's page ─────────────────────────────────────────────────

/** A workspace's key, as the status lists it, in one line, `host` (the workspace's host, "The box") named; null when it is ready. */
export function keyLine(key: LifeosKeyState | undefined, host?: string | null): { line: string; failed?: boolean } | null {
  if (!key || key.state === "ready") return null;
  if (key.state === "waiting") return { line: `Its key is made once LifeOS is signed in on ${nameInLine(host || "this host")}` };
  if (key.state === "elsewhere") return { line: "Its key is made on the host that holds its add-ons" };
  return { line: key.error ?? "Its key could not be made", failed: true };
}

/**
 * A Work workspace's own page (`ws:<id>`): its sector (set when it was
 * made), where its threads run and whose desktop they may use, its house
 * rules and voice (work/rules), and the model they start on (the
 * workspace's thread defaults). Its switches are the host's admin rule
 * (`work.workspace.set`): a key that may not write them sees one line in
 * their place, said once on the page; Voice, Waiting on and the model, the
 * same rule, are then not drawn.
 */
export function WorkWorkspacePage({ workspaceId }: { workspaceId: string }) {
  const workspace = useWorkspaces().find((w) => w.id === workspaceId);
  const environments = useEnvironments();
  const status = useLifeosStatus(workspace?.environmentId);
  const [settings, setSettings] = useState<WorkspaceWorkSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Retry on a failed read asks again; a refused switch keeps its own line with no Retry (the switch is the retry).
  const [attempt, setAttempt] = useState(0);
  // His Retry keeps the failed line, spinning in place, until the answer replaces it.
  const [retrying, setRetrying] = useState(false);
  const [localHost, setLocalHost] = useState<string | null>(null);
  // The desktops the workspace's host knows that this window may have no link to (a PC registered with the box).
  const [far, setFar] = useState<WorkDesktop[]>([]);
  const mayWrite = useLinkMay(workspace?.environmentId ?? "", "work.workspace.set");
  const mayDefaults = useLinkMay(workspace?.environmentId ?? "", "defaults.set");
  useEffect(() => void localHostId().then(setLocalHost), []);
  useEffect(() => {
    if (!workspace) return;
    let live = true;
    Promise.all([workspaceSettings(workspace, { fresh: true }), hostDesktops(workspace)]).then(
      ([value, known]) => {
        if (!live) return;
        setSettings(value);
        setFar(known);
        setError(null);
        setRetrying(false);
      },
      (err: unknown) => {
        if (!live) return;
        setError(failureWords(err, hostOf(workspace.environmentId), "did not send this workspace's settings"));
        setRetrying(false);
      },
    );
    return () => {
      live = false;
    };
  }, [workspace?.id, workspace?.environmentId, attempt]);
  if (!workspace) return null;
  const host = environments.find((e) => e.id === workspace.environmentId);
  const desktops = desktopRows(environments, far, localHost);
  // While the host's LifeOS is down the Sector row says its sector alone: Waiting on says the state once, with its press.
  const key = status && status.lifeos.state !== "connected" ? null : keyLine(status?.keys.find((k) => k.workspaceId === workspace.id), host?.name);
  /** The desktops it may use other than its own host: where a Teams file lies that a copy would bring here. */
  const otherDesktops = (list: readonly string[]): string[] => list.filter((id) => id !== workspace.environmentId && id !== hostIdOfLink(workspace.environmentId, localHost));
  // The list holds host ids; this machine's link is "local" in the window, its host id on every host.
  const allow = async (link: string, next: boolean): Promise<boolean> => {
    if (!settings) return false;
    const desktop = hostIdOfLink(link, localHost);
    const kept = settings.mayUseDesktop.filter((id) => id !== desktop && id !== link);
    const list = next ? [...kept, desktop] : kept;
    try {
      setSettings(await setWorkspaceSettings(workspace, { mayUseDesktop: list }));
      setError(null);
      return true;
    } catch (err) {
      setError(failureWords(err, hostOf(workspace.environmentId), "did not save the change", true));
      return false;
    }
  };
  return (
    <>
      <PageSection title="LifeOS">
        {workspace.sector ? (
          <PageRow
            title="Sector"
            media={<SectorDot sector={workspace.sector} />}
            description={key && !key.failed ? `${sectorName(workspace.sector)}. ${key.line}` : sectorName(workspace.sector)}
            error={key?.failed ? key.line : undefined}
          />
        ) : (
          <PageEmpty>No sector</PageEmpty>
        )}
      </PageSection>
      <PageSection title="Where it runs">
        <PageRow title="Threads run on" description={host?.name ?? "A host not linked here"} />
        {!mayWrite ? (
          // The line names what it stands for: the computer use switches and the copy are hidden from this key.
          <PageEmpty>{`Computer use is changed from a computer that manages ${nameInLine(host?.name ?? "it")}`}</PageEmpty>
        ) : settings ? (
          desktops.map((desktop) => (
            <PageRow key={desktop.host} title={`Computer use on ${nameInLine(desktop.name)}`}>
              <SettingSwitch label={`Computer use on ${nameInLine(desktop.name)}`} on={settings.mayUseDesktop.includes(desktop.host) || settings.mayUseDesktop.includes(desktop.link)} onChange={(next) => allow(desktop.link, next)} />
            </PageRow>
          ))
        ) : error ? null : (
          <PageRowsSkeleton rows={Math.max(1, desktops.length)} description control="switch" />
        )}
        {settings && mayWrite ? (
          <WinvmWorkspaceRow
            env={workspace.environmentId}
            on={!!settings.windowsVm}
            onChange={async (next) => {
              try {
                setSettings(await setWorkspaceSettings(workspace, { windowsVm: next }));
                setError(null);
                return true;
              } catch (err) {
                setError(failureWords(err, hostOf(workspace.environmentId), "did not save the change", true));
                return false;
              }
            }}
          />
        ) : null}
        {settings && mayWrite && host && otherDesktops(settings.mayUseDesktop).length ? (
          <TeamsCopyRow workspace={workspace} hostName={nameInLine(host.name)} desktops={otherDesktops(settings.mayUseDesktop).map((id) => environments.find((e) => e.id === (linkIdOfHost(id, localHost) ?? id))?.name ?? far.find((d) => d.id === id)?.name ?? id)} />
        ) : null}
        {error ? (
          <PageError
            action={
              settings ? undefined : (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={retrying}
                  onClick={() => {
                    setRetrying(true);
                    setAttempt((n) => n + 1);
                  }}
                >
                  <BusyLabel busy={retrying} label="Retry" />
                </Button>
              )
            }
          >
            {error}
          </PageError>
        ) : null}
      </PageSection>
      <HouseRules workspace={workspace} />
      {workspace.sector ? <WaitingSection workspace={workspace} /> : null}
      {mayDefaults ? <ThreadDefaultsEditor workspaceId={workspace.id} /> : null}
    </>
  );
}

/** A code workspace's LifeOS link, on its own page: its threads can read and draft in that sector. */
export function CodeWorkspaceSector({ workspaceId }: { workspaceId: string }) {
  const workspace = useWorkspaces().find((w) => w.id === workspaceId);
  const on = useWorkHosts();
  const status = useLifeosStatus(workspace?.environmentId);
  const session = useLifeosSession(workspace?.environmentId ?? "", null);
  const listed = useLifeosQuery<{ key: string; label: string }[]>(session, "sectors:list", {});
  const names = useMemo(() => new Map(listed.status === "ready" ? listed.value.map((s) => [s.key, s.label] as const) : []), [listed]);
  const [error, setError] = useState<string | null>(null);
  // Linking needs a key that manages the host: a given computer's window sees the sector, and who can change it.
  const mayLink = useLinkMay(workspace?.environmentId ?? "", "work.lifeos.link");
  const host = useEnvironments().find((e) => e.id === workspace?.environmentId)?.name ?? "this host";
  if (!workspace || workspace.kind === "work" || !on.has(workspace.environmentId)) return null;
  const connected = status?.lifeos.state === "connected";
  if (!mayLink) {
    return (
      <PageSection title="LifeOS">
        {workspace.sector ? <PageRow title="Sector" description={sectorName(workspace.sector, names)} media={<SectorDot sector={workspace.sector} />} /> : null}
        <PageEmpty>{managedElsewhere(host)}</PageEmpty>
      </PageSection>
    );
  }
  const key = workspace.sector ? keyLine(status?.keys.find((k) => k.workspaceId === workspace.id), host) : null;
  return (
    <PageSection title="LifeOS">
      {connected || workspace.sector ? (
        <PageRow
          title="Sector"
          description={key && !key.failed ? key.line : "Its threads can read and draft in this sector"}
          media={<SectorDot sector={workspace.sector ?? null} />}
          error={error ?? (key?.failed ? key.line : undefined)}
        >
          <ChoiceSelect
            size="sm"
            label="LifeOS sector"
            value={(workspace.sector as string | undefined) ?? "none"}
            options={[{ value: "none", label: "None" }, ...SECTORS.map((sector) => ({ value: sector, label: sectorName(sector, names) }))]}
            onChange={(next) => {
              setError(null);
              void linkSector(workspace as WorkspaceMeta, next === "none" ? null : (next as SectorKey)).catch((err: unknown) => setError(failureWords(err, host, "did not link the sector", true)));
            }}
          />
        </PageRow>
      ) : (
        <LifeosLine session={session} waiting={<PageRowsSkeleton rows={[{ description: true, media: true, control: "select" }]} />} />
      )}
    </PageSection>
  );
}
