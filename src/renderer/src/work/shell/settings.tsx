import { useEffect, useMemo, useState, type FormEvent } from "react";
import type { SectorKey, WorkspaceWorkSettings } from "@shared/work";
import type { LifeosKeyState, LifeosState, LifeosStatus } from "@shared/contract-work-lifeos";
import { SectorDot } from "../../chrome/WorkspaceGlyph";
import { ThreadDefaultsEditor } from "../../chrome/ThreadDefaultsDialog";
import { ModalPanel, useClosingDialog } from "../../chrome/Modal";
import { Field } from "../../chrome/DialogField";
import { DialogFooter, ErrorLine, errorText } from "../../chrome/ConfirmDialog";
import { ChoiceSelect } from "../../components/choice-select";
import { PageEmpty, PageError, PageRow, PageRowsSkeleton, PageSection } from "../../components/page";
import { SettingSwitch } from "../../components/setting-switch";
import { BusyLabel, Button } from "../../components/ui/button";
import { Dialog } from "../../components/ui/dialog";
import { Input } from "../../components/ui/input";
import { registry, useEnvironments } from "../../lib/connection";
import { clockTime } from "../../lib/duration";
import { requestSettings } from "../../lib/monaco/debugTab";
import type { WorkspaceMeta } from "../../lib/tcserver/types";
import { useWorkspaces } from "../../lib/tcserver/workspaces";
import { useWorkHosts } from "../../lib/workSwitch";
import { ToolchainRow } from "../formats/ToolchainRow";
import { AddinRow } from "../office/AddinRow";
import { HouseRules } from "../rules/HouseRules";
import { linkSector, sectorName, SECTORS, setWorkHome, setWorkspaceSettings, workHome, workspaceSettings } from "./actions";
import { useLifeosQuery, useLifeosSession, useLifeosStatus } from "./lifeos";

/**
 * Settings → Work while Work is on (prototype settings.html, "One Work
 * page"): LifeOS's sign-in per host, the model Work threads start on, and
 * where Work runs. A Work workspace's own page holds what is its own. Grants
 * and guest links join this page with the Outbox (milestone 14) and guest
 * links (milestone 31).
 */

/** What a host's LifeOS state reads as, in one line. */
export function lifeosLine(state: LifeosState, now = Date.now()): { line: string; failed?: boolean } {
  switch (state.state) {
    case "connected":
      return { line: "Signed in" };
    case "signed-out":
    case "off":
      return { line: "Not signed in" };
    case "pairing":
      return { line: `Waiting for approval, ${Math.max(0, Math.ceil((state.expiresAt - now) / 60_000))} min left` };
    case "connecting":
      return { line: "Connecting…" };
    case "unreachable":
      return { line: `LifeOS did not answer, since ${clockTime(state.since)}`, failed: true };
    case "refused":
      return { line: "LifeOS refused this host's sign-in", failed: true };
  }
}

export function WorkSettingsBody() {
  const environments = useEnvironments();
  const on = useWorkHosts();
  const hosts = environments.filter((e) => on.has(e.id));
  const [home, setHome] = useState(() => workHome(environments));
  return (
    <>
      <PageSection title="LifeOS">
        {hosts.map((host) => (
          <LifeosHostRow key={host.id} environmentId={host.id} name={hosts.length > 1 ? host.name : "LifeOS"} />
        ))}
        {home ? <SectorsRow environmentId={home} /> : null}
      </PageSection>
      <PageSection title="Models">
        <PageRow title="Work threads" description="Same as code threads" onOpen={() => requestSettings("defaults")} openLabel="Thread defaults" />
      </PageSection>
      <PageSection title="Where it runs">
        {hosts.length > 1 ? (
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
        ) : null}
        {hosts.map((host) => (
          <ToolchainRow key={host.id} link={registry.linkOf(host.id)} />
        ))}
        {hosts.map((host) => (
          <AddinRow key={host.id} link={registry.linkOf(host.id)} title={hosts.length > 1 ? `Office add-in on ${host.name}` : "Office add-in"} />
        ))}
      </PageSection>
    </>
  );
}

/** One host's LifeOS sign-in: its state, then Sign in… or Sign out. */
function LifeosHostRow({ environmentId, name }: { environmentId: string; name: string }) {
  const status = useLifeosStatus(environmentId);
  const [signingIn, setSigningIn] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!status) return <PageRowsSkeleton rows={1} description control="button" />;
  const state = status.lifeos;
  const { line, failed } = lifeosLine(state);
  const signOut = async (): Promise<void> => {
    setPending(true);
    setError(null);
    try {
      await registry.linkOf(environmentId).request<LifeosStatus>("work.lifeos.signOut", {});
    } catch (err) {
      setError(errorText(err));
    } finally {
      setPending(false);
    }
  };
  const signedIn = state.state === "connected" || state.state === "unreachable" || state.state === "connecting";
  return (
    <>
      <PageRow title={name} description={failed ? undefined : line} error={failed ? line : (error ?? undefined)}>
        {signedIn ? (
          <Button variant="ghost" size="sm" disabled={pending} onClick={() => void signOut()}>
            <BusyLabel busy={pending} label="Sign out" />
          </Button>
        ) : (
          <Button variant="secondary" size="sm" onClick={() => setSigningIn(true)}>
            {state.state === "pairing" ? "Show code…" : "Sign in…"}
          </Button>
        )}
      </PageRow>
      {signingIn ? <SignInDialog environmentId={environmentId} state={state} onClose={() => setSigningIn(false)} /> : null}
    </>
  );
}

/** The sectors LifeOS has, each with its dot: what this host's Work threads can be linked to. */
function SectorsRow({ environmentId }: { environmentId: string }) {
  const session = useLifeosSession(environmentId, null);
  const listed = useLifeosQuery<{ key: string; label: string; order: number }[]>(session, "sectors:list", {});
  if (session.state !== "connected") return null;
  if (listed.status === "loading") return <PageRowsSkeleton rows={1} description control="none" />;
  if (listed.status === "failed") return <PageError>{listed.error}</PageError>;
  return (
    <PageRow
      title="Sectors"
      description={
        <span className="flex flex-wrap gap-x-3 gap-y-1">
          {[...listed.value]
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
 * Sign in by pairing (the host polls for its token itself), or with a
 * device token made in LifeOS (`auth:mint`) while LifeOS's approve screen
 * has not shipped. The code is shown only to this window, an admin.
 */
function SignInDialog({ environmentId, state, onClose }: { environmentId: string; state: LifeosState; onClose: () => void }) {
  const link = registry.linkOf(environmentId);
  const [code, setCode] = useState<{ code: string; expiresAt: number } | null>(
    state.state === "pairing" && state.code ? { code: state.code, expiresAt: state.expiresAt } : null,
  );
  const [token, setToken] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { root, closeThen } = useClosingDialog(onClose, pending);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (code) return;
    let live = true;
    link
      .request<{ code: string; expiresAt: number }>("work.lifeos.pairStart", {})
      .then((answer) => live && setCode(answer), (err: unknown) => live && setError(errorText(err)));
    return () => {
      live = false;
    };
  }, [code, link]);
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
      setError(errorText(err));
      setPending(false);
    }
  };
  const left = code ? Math.max(0, Math.ceil((code.expiresAt - now) / 1000)) : 0;

  return (
    <Dialog {...root}>
      <ModalPanel onClose={cancel} busy={pending} title="Sign in to LifeOS" description="Approve this code in LifeOS, under Approve a sign-in." size="sm">
        <form onSubmit={(event) => void submit(event)}>
          <div className="flex flex-col gap-4 px-5 py-4">
            <div className="flex items-baseline justify-between gap-3">
              {code ? (
                <span className="font-mono text-base font-medium leading-6 text-foreground tabular-nums">{code.code}</span>
              ) : (
                <span className="text-xs text-muted-foreground">Asking for a code…</span>
              )}
              {code ? (
                <span className="text-xs text-muted-foreground tabular-nums">
                  {left > 0 ? `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}` : "Expired"}
                </span>
              ) : null}
            </div>
            <Field label="Or a device token">
              <Input value={token} onChange={(event) => setToken(event.target.value)} placeholder="lo_…" spellCheck={false} autoComplete="off" />
            </Field>
            <ErrorLine error={error} />
          </div>
          <DialogFooter onCancel={cancel} confirmLabel="Sign in" pending={pending} disabled={!token.trim()} />
        </form>
      </ModalPanel>
    </Dialog>
  );
}

// ── a workspace's page ─────────────────────────────────────────────────

/** A workspace's key, as the status lists it, in one line; null when it is ready. */
export function keyLine(key: LifeosKeyState | undefined): { line: string; failed?: boolean } | null {
  if (!key || key.state === "ready") return null;
  if (key.state === "waiting") return { line: "Its key is made once LifeOS is signed in on this host" };
  if (key.state === "elsewhere") return { line: "Its key is made on the host that holds its add-ons" };
  return { line: key.error ?? "Its key could not be made", failed: true };
}

/** The hosts whose desktop a workspace's threads may use: the Macs and Windows machines this window knows. */
const isDesktop = (platform: string | undefined): boolean => platform === "darwin" || platform === "win32";

/**
 * A Work workspace's own page (`ws:<id>`): its sector (set when it was
 * made), where its threads run and whose desktop they may use, its house
 * rules and voice (work/rules), and the model they start on (the
 * workspace's thread defaults).
 */
export function WorkWorkspacePage({ workspaceId }: { workspaceId: string }) {
  const workspace = useWorkspaces().find((w) => w.id === workspaceId);
  const environments = useEnvironments();
  const status = useLifeosStatus(workspace?.environmentId);
  const [settings, setSettings] = useState<WorkspaceWorkSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!workspace) return;
    let live = true;
    workspaceSettings(workspace).then(
      (value) => live && setSettings(value),
      (err: unknown) => live && setError(errorText(err)),
    );
    return () => {
      live = false;
    };
  }, [workspace?.id, workspace?.environmentId]);
  if (!workspace) return null;
  const host = environments.find((e) => e.id === workspace.environmentId);
  const desktops = environments.filter((e) => isDesktop(e.platform));
  const key = keyLine(status?.keys.find((k) => k.workspaceId === workspace.id));
  const allow = async (desktop: string, next: boolean): Promise<boolean> => {
    if (!settings) return false;
    const list = next ? [...new Set([...settings.mayUseDesktop, desktop])] : settings.mayUseDesktop.filter((id) => id !== desktop);
    try {
      setSettings(await setWorkspaceSettings(workspace, { mayUseDesktop: list }));
      setError(null);
      return true;
    } catch (err) {
      setError(errorText(err));
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
        <PageRow title="Threads run on" description={host?.name ?? workspace.environmentId} />
        {settings ? (
          desktops.map((desktop) => (
            <PageRow key={desktop.id} title={`Computer use on ${desktop.name}`}>
              <SettingSwitch label={`Computer use on ${desktop.name}`} on={settings.mayUseDesktop.includes(desktop.id)} onChange={(next) => allow(desktop.id, next)} />
            </PageRow>
          ))
        ) : error ? null : (
          <PageRowsSkeleton rows={Math.max(1, desktops.length)} description control="switch" />
        )}
        {error ? <PageError>{error}</PageError> : null}
      </PageSection>
      <HouseRules workspace={workspace} />
      <ThreadDefaultsEditor workspaceId={workspace.id} />
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
  if (!workspace || workspace.kind === "work" || !on.has(workspace.environmentId)) return null;
  const connected = status?.lifeos.state === "connected";
  const key = workspace.sector ? keyLine(status?.keys.find((k) => k.workspaceId === workspace.id)) : null;
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
              void linkSector(workspace as WorkspaceMeta, next === "none" ? null : (next as SectorKey)).catch((err: unknown) => setError(errorText(err)));
            }}
          />
        </PageRow>
      ) : (
        <PageEmpty>Sign in to LifeOS to link a sector</PageEmpty>
      )}
    </PageSection>
  );
}
