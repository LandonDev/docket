import { useHostLinkDown } from "./hostLinkDown";
import { retryLink } from "./linkRetry";
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
import { Skeleton } from "../../components/ui/skeleton";
import { loadToast } from "../../components/ui/toaster";
import { useEnvironments } from "../../lib/connection";
import { linkMay } from "../../lib/linkMay";
import type { WorkspaceMeta } from "../../lib/tcserver/types";
import { useWorkspaces, workspaceByPath } from "../../lib/tcserver/workspaces";
import { workRailPort, useWorkHosts } from "../../lib/workSwitch";
import { FileDrops } from "../canvas/fileDrop";
import { workDigestChunk } from "../../surfaces/chunks";
import { openWorkSettings } from "./open";
import { PlaysHost } from "../routines/plays/PlaysHost";
import { TemplatesHost } from "../templates/TemplatesHost";
import { ClashHost } from "../clashes/ClashHost";
import { ReturnHost } from "./ReturnHost";
import { downOf, downPress, downWords, useDownPress, type DownPress, type LifeosDown } from "./lifeosDown";
import { SignInFor } from "./DownSignIn";
import { createWorkWorkspace, linkSector, sectorName, SECTORS, workHome } from "./actions";
import { isSilence, lifeosHostName, reopenLifeos, sessionWords, useLifeosQuery, useLifeosSession, useLifeosStatus, type LifeosSession } from "./lifeos";
import { connectingWords } from "./lifeosWords";

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

/** What the + menu reads for the home host: connected, on its way, or down by the rule (`LifeosDown`). */
export type AddMenuState = "connected" | "connecting" | LifeosDown | null;

/** Each press's row id and its name in a menu, where a row that opens a dialog ends in "…". */
const MENU_PRESS: Record<DownPress, { id: string; label: string }> = {
  retry: { id: "work:retry", label: "Retry" },
  "sign-in": { id: "work:signin", label: "Sign in…" },
  code: { id: "work:code", label: "Show the code…" },
  settings: { id: "work:settings", label: "Open Settings" },
};

/**
 * The Work heading's + menu (prototype add.html, "One click"): one row per free sector, then Without a sector. A home
 * session that is down says its state once, in the rule's words (`said`: `sessionWords`, the computer named), with the
 * rule's press as the row (`downPress`); where this window may not make it, the state and who can (`elsewhere`) as a
 * note; a computer the host keeps LifeOS from, the state alone as a note. Without a sector keeps its own way.
 */
export function addMenuRows(state: AddMenuState, free: readonly string[], names?: ReadonlyMap<string, string>, said?: string, elsewhere?: string | null, host?: string | null, retrying = false, linkDown?: string | null): MenuRow[] {
  if (linkDown) return [{ kind: "item", ...MENU_PRESS.retry, description: linkDown, keepOpen: true, busy: retrying }];
  const note = (id: string, words: string, who?: string | null): MenuRow => ({ kind: "note", id, content: <span className="text-muted-foreground">{words}{who ? <span className="block">{who}</span> : null}</span> });
  const down = (gone: LifeosDown): MenuRow[] => {
    const words = said ?? downWords(gone);
    const press = downPress(gone);
    if (!press) return [note("work:withheld", words)];
    if (elsewhere) return [note(press === "settings" ? "work:off" : "work:signin-elsewhere", words, elsewhere)];
    // Retry asks the host in place: the menu stays open, the row spins, and the answer's state replaces the row.
    const retry = press === "retry" ? { keepOpen: true, ...(retrying ? { busy: true } : {}) } : {};
    return [{ kind: "item", ...MENU_PRESS[press], ...(press === "sign-in" || press === "code" ? { icon: LogIn } : {}), description: words, ...retry }];
  };
  const top: MenuRow[] =
    state === "connected"
      ? free.map((sector) => ({ kind: "item", id: `work:add:${sector}`, label: sectorName(sector, names), icon: dotIcon(sector) }))
      : state === "connecting"
        ? [{ kind: "note", id: "work:connecting", content: <span className="text-muted-foreground">{connectingWords(host)}</span> }]
        : state === null
          ? // No status heard yet: the host has said nothing, so a muted bone in the sectors' place, never a wait it did not say.
            [{ kind: "note", id: "work:reading", content: <span role="status" aria-label="Reading LifeOS" className="flex h-4 items-center"><Skeleton className="h-3 w-28" /></span> }]
          : down(state);
  return [...top, ...(top.length ? [{ kind: "sep" } as const] : []), { kind: "item", id: "work:add-unlinked", label: "Without a sector…", icon: dotIcon(null) }];
}

/**
 * The state the + menu reads for the home host: its status; once that says connected, this window's own session where
 * it is down (a computer the host keeps LifeOS from, a session ask the host did not answer); with no status, a host
 * whose status ask went unanswered. Never "LifeOS is still connecting" for a wait that has ended.
 */
export function addMenuState(status: LifeosStatus | null, session: Pick<LifeosSession, "client" | "state" | "withheld" | "unanswered">): AddMenuState {
  if (!status) return session.unanswered ? "unanswered" : null;
  const state = status.lifeos.state;
  if (state !== "connected") return state;
  return downOf(session) ?? "connected";
}

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
 * The add menu's Retry: asks the host for its LifeOS status now and, once it says connected, the session again
 * (`reopenLifeos`). Watching it again would start nothing, since the rail already watches that host; an answer that
 * does not come is said once, as a toast.
 */
export function retryLifeos(home: string | null | undefined, fail: (error: unknown) => void, done?: () => void): void {
  // A Retry the host does not answer is said by the line alone (the menu's row, Settings → Work's line): the newest
  // cause, judged by the Retry's own error, never by the state before the press.
  if (!home) return done?.();
  void reopenLifeos(home, null)
    .catch((error: unknown) => (isSilence(error) ? undefined : fail(error)))
    .finally(() => done?.());
}

/** The open + menu, hearing the port's rows change (`WorkRailPort.subscribe`). */
const railListeners = new Set<() => void>();

export function WorkRailHost({ onOpenWorkspace }: { onOpenWorkspace: (path: string) => void }) {
  const environments = useEnvironments();
  const hosts = useWorkHosts();
  const home = useMemo(() => workHome(environments), [environments, hosts]);
  const status = useLifeosStatus(home);
  const session = useLifeosSession(home ?? "", null);
  const linkDown = useHostLinkDown(home);
  const state = addMenuState(status, session);
  const hostState: LifeosStateName | null = status?.lifeos.state ?? (session.unanswered ? "unreachable" : null);
  const said = sessionWords(session);
  // The rule's press for the home host's sign-in and switch: offered only where this window may make it, else who can.
  const menuPress = useDownPress(state === "connected" || state === "connecting" ? null : state, home ?? "");
  // Sign in… and Show the code… open the sign-in dialog here, as every reader's press does.
  const [signingIn, setSigningIn] = useState(false);
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
  // The + menu's Retry is out: its row spins in the open menu until the host's answer replaces it.
  const [retrying, setRetrying] = useState(false);

  useLayoutEffect(() => {
    const fail = (error: unknown): void => void loadToast().then((toast) => toast.error(errorText(error)));
    const workspaceAt = (path: string | null): WorkspaceMeta | undefined => (path ? workspaceByPath(workspaces, path) : undefined);
    workRailPort.set({
      subscribe: (listener) => (railListeners.add(listener), () => void railListeners.delete(listener)),
      addRows: () => addMenuRows(state, freeSectors(workspaces, order), names, said, menuPress.elsewhere, home ? lifeosHostName(home) : null, retrying, linkDown),
      sectorRows(path) {
        const workspace = workspaceAt(path);
        if (!workspace || !sectorMenuShown(workspace, hosts)) return [];
        // A code workspace links on its own host, whose LifeOS session mints its key.
        // The link is the host's own act: its status says whether it can, not this window's session.
        const there = workspace.environmentId === home ? hostState : null;
        return sectorMenuRows(workspace.sector, there ?? "connected", names, order);
      },
      pick(action, path) {
        if (action === "work:signin" || action === "work:code") return setSigningIn(true);
        if (action === "work:settings") return openWorkSettings();
        if (action === "work:retry") {
          setRetrying(true);
          if (linkDown && home) return void retryLink(home).finally(() => setRetrying(false));
          return retryLifeos(home, fail, () => setRetrying(false));
        }
        if (linkDown && action.startsWith("work:add")) return;
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
    // An open + menu reads its rows again: a Retry's answer replaces its row in place.
    for (const listener of railListeners) listener();
    return () => workRailPort.set(null);
  }, [home, hostState, hosts, linkDown, names, onOpenWorkspace, order, state, said, menuPress.elsewhere, session.unanswered, workspaces, retrying]);

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
      {signingIn && home ? <SignInFor environmentId={home} onClose={() => setSigningIn(false)} /> : null}
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
