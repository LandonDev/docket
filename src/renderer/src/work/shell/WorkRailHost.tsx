import { useLayoutEffect, useMemo, useState, type FormEvent } from "react";
import type { SectorKey } from "@shared/work";
import type { LifeosStateName } from "@shared/contract-work-lifeos";
import { LogIn } from "../../chrome/icons";
import type { MenuIcon, MenuRow } from "../../chrome/menuRows";
import { SectorDot } from "../../chrome/WorkspaceGlyph";
import { ModalPanel, useClosingDialog } from "../../chrome/Modal";
import { Field } from "../../chrome/DialogField";
import { DialogFooter, ErrorLine, errorText } from "../../chrome/ConfirmDialog";
import { Dialog } from "../../components/ui/dialog";
import { Input } from "../../components/ui/input";
import { loadToast } from "../../components/ui/toaster";
import { useEnvironments } from "../../lib/connection";
import type { WorkspaceMeta } from "../../lib/tcserver/types";
import { useWorkspaces, workspaceByPath } from "../../lib/tcserver/workspaces";
import { workRailPort, useWorkHosts } from "../../lib/workSwitch";
import { openWorkSettings } from "./open";
import { createWorkWorkspace, linkSector, sectorName, SECTORS, workHome } from "./actions";
import { useLifeosQuery, useLifeosSession, useLifeosStatus, watchLifeos } from "./lifeos";

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

/** The Work heading's + menu (prototype add.html, "One click"): one row per free sector, then Without a sector. */
export function addMenuRows(state: LifeosStateName | null, free: readonly string[], names?: ReadonlyMap<string, string>): MenuRow[] {
  const top: MenuRow[] =
    state === "connected"
      ? free.map((sector) => ({ kind: "item", id: `work:add:${sector}`, label: sectorName(sector, names), icon: dotIcon(sector) }))
      : state === "signed-out" || state === "refused"
        ? [{ kind: "item", id: "work:signin", label: "Sign in to LifeOS…", icon: LogIn }]
        : state === "unreachable"
          ? [{ kind: "item", id: "work:retry", label: "Retry", description: "LifeOS did not answer" }]
          : [{ kind: "note", id: "work:connecting", content: <span className="text-muted-foreground">Connecting to LifeOS…</span> }];
  return [...top, ...(top.length ? [{ kind: "sep" } as const] : []), { kind: "item", id: "work:add-unlinked", label: "Without a sector…", icon: dotIcon(null) }];
}

/** A code workspace's "LifeOS sector" submenu: None, then each sector, the linked one ticked. */
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
export function WorkRailHost({ onOpenWorkspace }: { onOpenWorkspace: (path: string) => void }) {
  const environments = useEnvironments();
  const hosts = useWorkHosts();
  const home = useMemo(() => workHome(environments), [environments, hosts]);
  const status = useLifeosStatus(home);
  const state = status?.lifeos.state ?? null;
  const session = useLifeosSession(home ?? "", null);
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
      addRows: () => addMenuRows(state, freeSectors(workspaces, order), names),
      sectorRows(path) {
        const workspace = workspaceAt(path);
        if (!workspace || workspace.kind === "work" || !hosts.has(workspace.environmentId)) return [];
        // A code workspace links on its own host, whose LifeOS session mints its key.
        const there = workspace.environmentId === home ? state : null;
        return sectorMenuRows(workspace.sector, there ?? "connected", names, order);
      },
      pick(action, path) {
        if (action === "work:signin") return openWorkSettings();
        if (action === "work:retry") {
          if (home) watchLifeos(home);
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
  }, [home, hosts, names, onOpenWorkspace, order, state, workspaces]);

  return naming && home ? (
    <NameWorkspaceDialog
      environmentId={home}
      taken={workspaces.filter((w) => w.environmentId === home).map((w) => w.name)}
      onClose={() => setNaming(false)}
      onCreated={(w) => {
        setNaming(false);
        onOpenWorkspace(w.path);
      }}
    />
  ) : null;
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
          <div className="flex flex-col gap-4 px-5 py-4">
            <Field label="Name">
              <Input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="Side projects" />
            </Field>
            <ErrorLine error={clash ? "A workspace there already has that name" : error} />
          </div>
          <DialogFooter onCancel={() => closeThen(onClose)} confirmLabel="Create" pending={pending} disabled={!trimmed || clash} />
        </form>
      </ModalPanel>
    </Dialog>
  );
}
