import { useLayoutEffect, useMemo, useState, type FormEvent } from "react";
import type { SectorKey } from "@shared/work";
import type { LifeosStateName, LifeosStatus } from "@shared/contract-work-lifeos";
import { LogIn } from "../../chrome/icons";
import type { MenuIcon, MenuRow } from "../../chrome/menuRows";
import { SectorDot } from "../../chrome/WorkspaceGlyph";
import { ModalBody, ModalPanel, useClosingDialog } from "../../chrome/Modal";
import { Field } from "../../chrome/DialogField";
import { DialogFooter, ErrorLine, errorText } from "../../chrome/ConfirmDialog";
import { Dialog } from "../../components/ui/dialog";
import { Input } from "../../components/ui/input";
import { loadToast } from "../../components/ui/toaster";
import { useEnvironments } from "../../lib/connection";
import { linkMay } from "../../lib/linkMay";
import type { WorkspaceMeta } from "../../lib/tcserver/types";
import { useWorkspaces, workspaceByPath } from "../../lib/tcserver/workspaces";
import { workRailPort, useWorkHosts } from "../../lib/workSwitch";
import { FileDrops } from "../canvas/fileDrop";
import { workDigestChunk } from "../../surfaces/chunks";
import { openConnections, openWorkSettings } from "./open";
import { PlaysHost } from "../routines/plays/PlaysHost";
import { TemplatesHost } from "../templates/TemplatesHost";
import { ClashHost } from "../clashes/ClashHost";
import { ReturnHost } from "./ReturnHost";
import { createWorkWorkspace, linkSector, sectorName, SECTORS, workHome } from "./actions";
import { refreshLifeos, sessionWords, useLifeosQuery, useLifeosSession, useLifeosStatus, type LifeosSession } from "./lifeos";

/** The digest's toasts and its list (work/digest), in a chunk of their own: nothing of it loads until Work is on. */
const DigestHost = workDigestChunk.surface("DigestHost");

/** A sector's dot as a menu row's glyph, one stable component per sector. */
const DOT_ICONS = new Map<string, MenuIcon>();
function dotIcon(sector: string | null): MenuIcon {
  const key = sector ?? "none";
  let icon = DOT_ICONS.get(key);
  if (!icon) {
    icon = function Dot() {
      return <SectorDot sector={sector} className="-mx-px" />;
    };
    DOT_ICONS.set(key, icon);
  }
  return icon;
}

/** The sectors not yet taken by a Work workspace on any host, in LifeOS's order. */
export function freeSectors(workspaces: readonly Pick<WorkspaceMeta, "kind" | "sector">[], order: readonly string[] = SECTORS): string[] {
  const taken = new Set(workspaces.filter((w) => w.kind === "work" && w.sector).map((w) => w.sector));
  return order.filter((sector) => !taken.has(sector));
}

/**
 * The Work heading's + menu (prototype add.html, "One click"): one row per free sector, then Without a sector. `said` is
 * the home session's own words for a state that is down (`sessionWords`: "The box did not answer", "Work is off on the
 * box"), so the menu names the computer as every view does.
 */
export function addMenuRows(state: LifeosStateName | null, free: readonly string[], names?: ReadonlyMap<string, string>, said?: string): MenuRow[] {
  const top: MenuRow[] =
    state === "connected"
      ? free.map((sector) => ({ kind: "item", id: `work:add:${sector}`, label: sectorName(sector, names), icon: dotIcon(sector) }))
      : state === "signed-out" || state === "refused"
        ? [{ kind: "item", id: "work:signin", label: "Sign in to LifeOS…", icon: LogIn }]
        : state === "pairing"
          ? [{ kind: "item", id: "work:signin", label: "Approve the LifeOS sign-in…", icon: LogIn }]
          : state === "unreachable"
            ? [{ kind: "item", id: "work:retry", label: "Retry", description: said ?? "LifeOS did not answer" }]
            : state === "off"
              ? [{ kind: "note", id: "work:off", content: <span className="text-muted-foreground">{said ?? "Work is off on this host"}</span> }]
              : [{ kind: "note", id: "work:connecting", content: <span className="text-muted-foreground">Connecting to LifeOS…</span> }];
  return [...top, ...(top.length ? [{ kind: "sep" } as const] : []), { kind: "item", id: "work:add-unlinked", label: "Without a sector…", icon: dotIcon(null) }];
}

/**
 * The state the + menu reads for the home host: its status, else, for a host whose status ask went unanswered,
 * unreachable, as every view says. Never "Connecting to LifeOS…" for a wait that has ended.
 */
export const addMenuState = (status: LifeosStatus | null, session: Pick<LifeosSession, "unanswered">): LifeosStateName | null =>
  status?.lifeos.state ?? (session.unanswered ? "unreachable" : null);

/** A code workspace's "LifeOS sector" submenu: None, then each sector, the linked one ticked. */
/**
 * Whether a workspace's rail row offers the LifeOS sector menu: a code workspace on a host with Work on, and a key that
 * may link it there (`work.lifeos.link` needs admin), so a given computer's rail never offers a pick the host refuses.
 */
export function sectorMenuShown(workspace: Pick<WorkspaceMeta, "kind" | "environmentId">, hosts: ReadonlySet<string>): boolean {
  return workspace.kind !== "work" && hosts.has(workspace.environmentId) && linkMay(workspace.environmentId, "work.lifeos.link");
}

export function sectorMenuRows(current: string | null | undefined, state: LifeosStateName | null, names?: ReadonlyMap<string, string>, order: readonly string[] = SECTORS): MenuRow[] {
  const choice = (id: string, label: string, sector: string | null): MenuRow => ({
    kind: "item",
    id,
    label,
    icon: dotIcon(sector),
    checked: (current ?? null) === sector,
  });
  return [
    {
      kind: "sub",
      id: "work:sector",
      label: "LifeOS sector",
      trailing: current ? <span className="text-muted-foreground">{sectorName(current, names)}</span> : undefined,
      disabled: state !== "connected" && !current,
      reason: state === "connected" || current ? undefined : "Sign in to LifeOS first",
      items: [choice("work:link:none", "None", null), ...order.map((sector) => choice(`work:link:${sector}`, sectorName(sector, names), sector))],
    },
    { kind: "sep" },
  ];
}

/**
 * Work's half of the rail, mounted by ProjectRail while a host has Work on:
 * it answers the rail's port (the + menu, a code workspace's sector
 * submenu, what a pick does) and holds the one dialog those open.
 */
/**
 * The add menu's Retry: asks the host for its LifeOS status now. Watching it again would start nothing,
 * since the rail already watches that host; a status that does not come is said once, as a toast.
 */
export function retryLifeos(home: string | null | undefined, fail: (error: unknown) => void): void {
  if (home) void refreshLifeos(home).catch(fail);
}

export function WorkRailHost({ onOpenWorkspace }: { onOpenWorkspace: (path: string) => void }) {
  const environments = useEnvironments();
  const hosts = useWorkHosts();
  const home = useMemo(() => workHome(environments), [environments, hosts]);
  const status = useLifeosStatus(home);
  const session = useLifeosSession(home ?? "", null);
  const state = addMenuState(status, session);
  const said = sessionWords(session);
  const listed = useLifeosQuery<{ key: string; label: string; order: number }[]>(session, "sectors:list", {});
  const names = useMemo(
    () => new Map(listed.status === "ready" ? listed.value.map((s) => [s.key, s.label] as const) : []),
    [listed],
  );
  const order = useMemo(
    () => (listed.status === "ready" && listed.value.length ? [...listed.value].sort((a, b) => a.order - b.order).map((s) => s.key) : SECTORS),
    [listed],
  );
  const workspaces = useWorkspaces();
  const [naming, setNaming] = useState(false);

  useLayoutEffect(() => {
    const fail = (error: unknown): void => void loadToast().then((toast) => toast.error(errorText(error)));
    const workspaceAt = (path: string | null): WorkspaceMeta | undefined => (path ? workspaceByPath(workspaces, path) : undefined);
    workRailPort.set({
      addRows: () => addMenuRows(state, freeSectors(workspaces, order), names, said),
      sectorRows(path) {
        const workspace = workspaceAt(path);
        if (!workspace || !sectorMenuShown(workspace, hosts)) return [];
        // A code workspace links on its own host, whose LifeOS session mints its key.
        const there = workspace.environmentId === home ? state : null;
        return sectorMenuRows(workspace.sector, there ?? "connected", names, order);
      },
      pick(action, path) {
        if (action === "work:signin") return openConnections();
        if (action === "work:retry") {
          // The host's silence is said already, by the menu's row and the line in Settings, Work, where the press goes: no toast then.
          retryLifeos(home, session.unanswered ? () => {} : fail);
          return openWorkSettings();
        }
        if (action === "work:add-unlinked") return setNaming(true);
        if (action.startsWith("work:add:") && home) {
          const sector = action.slice("work:add:".length) as SectorKey;
          void createWorkWorkspace(home, { sector, name: sectorName(sector, names) }).then((w) => onOpenWorkspace(w.path), fail);
          return;
        }
        if (action.startsWith("work:link:")) {
          const workspace = workspaceAt(path);
          const sector = action.slice("work:link:".length);
          if (workspace) void linkSector(workspace, sector === "none" ? null : (sector as SectorKey)).catch(fail);
        }
      },
    });
    return () => workRailPort.set(null);
  }, [home, hosts, names, onOpenWorkspace, order, state, said, session.unanswered, workspaces]);

  return (
    <>
      {/* Files dropped on Work open in a thread's canvas, wherever Work is on screen (work/canvas/fileDrop.tsx). */}
      <FileDrops />
      {/* Run a play… and Save as a play…, from wherever Work is on screen (work/routines/plays/PlaysHost.tsx). */}
      <PlaysHost />
      {/* New from a template and Save as template, for every screen of Work (work/templates/TemplatesHost.tsx). */}
      <TemplatesHost />
      {/* The Clash dialog, from an Agenda row or a Today row (work/clashes/ClashHost.tsx). */}
      <ClashHost />
      {/* The day's digest and what cannot wait, told once across hosts (work/digest). */}
      <DigestHost />
      {/* Where he was in each Work workspace: written as he moves, opened again after a launch (work/shell/ReturnHost.tsx). */}
      <ReturnHost />
      {naming && home ? (
        <NameWorkspaceDialog
          environmentId={home}
          taken={workspaces.filter((w) => w.environmentId === home).map((w) => w.name)}
          onClose={() => setNaming(false)}
          onCreated={(w) => {
            setNaming(false);
            onOpenWorkspace(w.path);
          }}
        />
      ) : null}
    </>
  );
}

/** "Without a sector…": the one thing to choose is the name. */
function NameWorkspaceDialog({
  environmentId,
  taken,
  onClose,
  onCreated,
}: {
  environmentId: string;
  taken: readonly string[];
  onClose: () => void;
  onCreated: (workspace: WorkspaceMeta) => void;
}) {
  const [name, setName] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { root, closeThen } = useClosingDialog(onClose, pending);
  const trimmed = name.trim();
  const clash = taken.some((t) => t.toLowerCase() === trimmed.toLowerCase());

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!trimmed || clash || pending) return;
    setPending(true);
    setError(null);
    try {
      const workspace = await createWorkWorkspace(environmentId, { sector: null, name: trimmed });
      setPending(false);
      closeThen(() => onCreated(workspace));
    } catch (err) {
      setError(errorText(err));
      setPending(false);
    }
  };

  return (
    <Dialog {...root}>
      <ModalPanel onClose={onClose} busy={pending} title="New Work workspace" size="sm">
        <form onSubmit={submit}>
          <ModalBody>
            <Field label="Name">
              <Input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="Side projects" />
            </Field>
            <ErrorLine error={clash ? "A workspace there already has that name" : error} />
          </ModalBody>
          <DialogFooter onCancel={() => closeThen(onClose)} confirmLabel="Create" pending={pending} disabled={!trimmed || clash} />
        </form>
      </ModalPanel>
    </Dialog>
  );
}
