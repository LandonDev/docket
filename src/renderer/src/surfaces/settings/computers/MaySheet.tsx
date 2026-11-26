import { useCallback, useEffect, useState } from "react";
import {
  MAC_BRIDGE_MAX_COMPUTER_CAP,
  MAC_BRIDGE_MAX_RUNNING_CAP,
  MAC_BRIDGE_MAX_THREADS_CAP,
  type MacBridgeHostPolicy,
  type MacBridgePolicy,
} from "@server/shared/contract-macbridge";
import { PageEmpty, PageError, PageRow, PageRowsSkeleton, PageSection } from "../../../components/page";
import { SettingSwitch } from "../../../components/setting-switch";
import { Button } from "../../../components/ui/button";
import { Input } from "../../../components/ui/input";
import { RadioChoice, RadioGroup } from "../../../components/ui/radio-group";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "../../../components/ui/sheet";
import { DialogFooter, ErrorLine, confirmAction } from "../../../chrome/ConfirmDialog";
import { Modal, ModalBody } from "../../../chrome/Modal";
import { MacBridgeRunningList } from "../../../chrome/MacBridgeRunning";
import { MacBridgeRuleList } from "../../../chrome/MacBridgeRemember";
import { macUrl } from "@server/shared/contract-ports";
import { openUrl } from "../../../lib/devPorts";
import { pickFolder } from "../../../lib/fs";
import {
  refreshMacBridgeHosts,
  refreshMacBridgeLoad,
  setMacBridgeComputer,
  setMacBridgeLimits,
  setMacBridgePolicy,
  setMacBridgeShared,
  useMacBridgeHosts,
  useMacBridgeRunning,
} from "../../../lib/macBridge";
import { loadMacBridgeRules, useMacBridgeRules } from "../../../lib/macBridgeRules";
import { thisDesktopInLine } from "../../../lib/native";
import { isWebMode } from "../../../lib/nativeWeb";
import { setForwarding, useHostForwards } from "../../../lib/portForwards";
import { MAY_SHEET_EVENT } from "../../../lib/settings/maySheet";
import { settingTitle } from "../../../lib/settings/map";
import { computerInLine, useComputerNames } from "../../../lib/settings/computerName";
import { refusalWords } from "../../../lib/settingsHome";
import { CommitField } from "../hosts/CommitField";
import { SaveMark } from "../parts/SaveMark";
import { SettingRow } from "../parts/SettingRow";
import { useSaved } from "../parts/useSaved";

/** Files and commands' four levels, least first, each with its own line. */
export const POLICIES: { value: MacBridgePolicy; label: string; line: string }[] = [
  { value: "off", label: "Off", line: "Nothing on this Mac." },
  { value: "read", label: "Read", line: "Reads the folders it may and your projects; asks for the rest." },
  { value: "read+run", label: "Read and run", line: "Also runs commands; each asks unless allowed until Docket quits." },
  { value: "full", label: "Full access", line: "Any file but keys and credentials." },
];

const rank = (policy: MacBridgePolicy): number => POLICIES.findIndex((p) => p.value === policy);
const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** What a computer may do here, in a few words: "Reads and runs commands, uses apps"; "Nothing". */
export function mayHereWords(host: Pick<MacBridgeHostPolicy, "policy" | "computer">): string {
  const files = { off: "Nothing", read: "Reads files", "read+run": "Reads and runs commands", full: "Full access to files and commands" }[host.policy];
  return host.policy !== "off" && host.computer ? `${files}, uses apps` : files;
}

/** The linked computers' rules and this Mac's load, every 5 s while a page or the sheet shows them (desktop only). */
export function useMacBridgePolling(enabled = true): void {
  useEffect(() => {
    if (!enabled || isWebMode()) return;
    const refresh = async (): Promise<void> => {
      // An older server answers an error: the rows stay away.
      if (!(await refreshMacBridgeHosts().then(() => true, () => false))) return;
      await refreshMacBridgeLoad().catch(() => null);
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5_000);
    return () => window.clearInterval(timer);
  }, [enabled]);
}

/**
 * The sheet's host, mounted once by SettingsView: it opens the sheet for whichever computer `openMaySheet` names
 * (lib/settings/maySheet.ts).
 */
export function MaySheetHost() {
  const [environmentId, setEnvironmentId] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const onAsk = (event: Event): void => {
      setEnvironmentId((event as CustomEvent<string>).detail);
      setOpen(true);
    };
    window.addEventListener(MAY_SHEET_EVENT, onAsk);
    return () => window.removeEventListener(MAY_SHEET_EVENT, onAsk);
  }, []);
  useMacBridgePolling(open);
  const host = useMacBridgeHosts().find((h) => h.environmentId === environmentId);
  return host ? <MaySheet host={host} open={open} onOpenChange={setOpen} /> : null;
}

/**
 * "What <computer> may do on this Mac", the one home of what one linked computer's threads may do here
 * (docs/agents/settings.md "The pages: computers"). Files and commands, a choice of four each with its line; lowering
 * it while its commands run asks first, naming how many end. Use this Mac's apps once it is above Off: on asks first,
 * saying what its threads may then do; off asks while it has live sessions. Then its dev sites, the folders it reads
 * without asking, its limits, what runs now with Stop, and what is allowed until Docket quits. Every control is this
 * Mac's own (`macBridge.*` and `ports.*` on the local server).
 */
export function MaySheet({ host, open, onOpenChange }: { host: MacBridgeHostPolicy; open: boolean; onOpenChange: (open: boolean) => void }) {
  // Mid-sentence, as every line of the sheet says it: "What the box may do on this Mac".
  const name = computerInLine(useComputerNames()(host.environmentId, host.name));
  const mac = thisDesktopInLine();
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" width={480} data-may-sheet={host.environmentId}>
        <SheetHeader>
          <SheetTitle>
            What {name} may do on {mac}
          </SheetTitle>
        </SheetHeader>
        <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-x-hidden overflow-y-auto px-5 pb-5">
          <MayBody host={host} name={name} mac={mac} />
        </div>
      </SheetContent>
    </Sheet>
  );
}

/** The sheet's sections, drawn alone by its test and its picture. */
export function MayBody({ host, name, mac }: { host: MacBridgeHostPolicy; name: string; mac: string }) {
  const files = useSaved();
  const [chosen, setChosen] = useState<MacBridgePolicy | null>(null);
  const policy = chosen ?? host.policy;
  const now = useRunningNow(host.environmentId);
  const choose = async (next: MacBridgePolicy): Promise<void> => {
    const ends = whatEnds(next, now);
    if (rank(next) < rank(host.policy) && ends) {
      const ok = await confirmAction({ title: `Lower what ${name} may do on ${mac}?`, body: ends, action: "Lower", danger: true });
      if (!ok) return;
    }
    setChosen(next);
    await files.run(() => setMacBridgePolicy(host.environmentId, next));
    setChosen(null);
  };
  return (
    <>
      <PageSection
        data-setting="sharing.files"
        title={settingTitle("sharing.files")}
        action={<SaveMark state={files.state} />}
        description={host.registered ? undefined : `Not linked to ${mac} right now.`}
      >
        <RadioGroup aria-label={`What ${name} may do on ${mac}`} value={policy} onValueChange={(next) => void choose(next as MacBridgePolicy)}>
          {POLICIES.map((p) => (
            <RadioChoice key={p.value} value={p.value} label={p.label} description={p.line} />
          ))}
        </RadioGroup>
        {files.error ? <PageError>{files.error}</PageError> : null}
      </PageSection>
      <LimitRows host={host} name={name} mac={mac} policy={policy} now={now} />
      {policy === "off" ? null : <Folders host={host} name={name} />}
      <Running host={host} name={name} />
      <Allowed environmentId={host.environmentId} />
    </>
  );
}

/** What runs here for one computer now, read from the one list "Commands and apps running now" draws, so the counts and the list agree. */
function useRunningNow(environmentId: string): { commands: number; waiting: number; apps: number } {
  const list = useMacBridgeRunning({ environmentId });
  const commands = list.filter((r) => r.kind !== "computer");
  return {
    commands: commands.filter((r) => r.status === "running").length,
    waiting: commands.filter((r) => r.status === "held").length,
    apps: list.filter((r) => r.kind === "computer" && r.status === "running").length,
  };
}

/**
 * What a new level ends, as this Mac's server ends it (`setPolicy`, src/main/server/remote/macBridge.ts): Off and Read
 * end its commands, running and waiting; Off also ends its live app sessions. Null when nothing it runs would end.
 */
export function whatEnds(next: MacBridgePolicy, now: { commands: number; waiting: number; apps: number }): string | null {
  const commands = next === "off" || next === "read" ? now.commands + now.waiting : 0;
  const apps = next === "off" ? now.apps : 0;
  const parts = [
    commands ? plural(commands, "command it runs here ends", "commands it runs here end") : null,
    apps ? plural(apps, "live app session ends", "live app sessions end") : null,
  ].filter(Boolean);
  return parts.length ? `${parts.join(", and ")}.` : null;
}

/** One form for every count of what Running now lists: "None running now", "2 running now", "2 running now, 1 waiting".
 *  Its threads take the same form. */
export const nowWords = (running: number, waiting = 0): string =>
  `${running === 0 ? "None running now" : `${running} running now`}${waiting > 0 ? `, ${waiting} waiting` : ""}`;

function LimitRows({ host, name, mac, policy, now }: { host: MacBridgeHostPolicy; name: string; mac: string; policy: MacBridgePolicy; now: ReturnType<typeof useRunningNow> }) {
  const apps = useSaved();
  const sites = useSaved();
  const commands = useSaved();
  const threads = useSaved();
  const driven = useSaved();
  const fwd = useHostForwards(host.environmentId);
  const runs = policy === "read+run" || policy === "full";
  const useApps = async (on: boolean): Promise<boolean> => {
    if (on) {
      const ok = await confirmAction({
        title: `Let ${name} use ${mac}'s apps?`,
        body: "Its threads may then see this screen and click and type in its apps. Each step asks unless the thread has full access.",
        action: "Allow",
      });
      if (!ok) return false;
    } else if (now.apps > 0) {
      const ok = await confirmAction({
        title: `Stop ${name} using ${mac}'s apps?`,
        body: `${plural(now.apps, "live session ends", "live sessions end")}.`,
        action: "Stop",
        danger: true,
      });
      if (!ok) return false;
    }
    return apps.run(() => setMacBridgeComputer(host.environmentId, on));
  };
  const limit = (saved: ReturnType<typeof useSaved>, key: "maxRunning" | "maxThreads" | "maxComputer") => (n: number | null) =>
    n === null ? undefined : saved.run(() => setMacBridgeLimits(host.environmentId, { [key]: n }));
  return (
    <PageSection>
      {policy === "off" ? null : (
        <SettingRow
          id="sharing.apps"
          vars={{ mac }}
          saved={apps}
          description={host.computerUnavailable ? `Not on ${mac}: ${host.computerUnavailable}` : "Each step asks unless the thread has full access."}
        >
          <SettingSwitch label={`Let ${name} use ${mac}'s apps`} on={host.computer} disabled={host.computerUnavailable !== null} onChange={useApps} />
        </SettingRow>
      )}
      {fwd ? (
        <SettingRow id="sharing.devSites" saved={sites}>
          <SettingSwitch label="Its dev sites open here" on={fwd.enabled} onChange={(on) => sites.run(() => setForwarding(host.environmentId, on))} />
        </SettingRow>
      ) : null}
      {fwd?.enabled
        ? fwd.forwards.map((f) => (
            <PageRow
              key={f.id}
              data-port-forward={f.id}
              title={f.title}
              description={f.macPort === null ? undefined : `localhost:${f.macPort}${f.macPort !== f.port ? `, ${f.port} is taken here` : ""}`}
              error={f.macPort === null ? (f.error ?? "Not open here") : undefined}
            >
              {f.macPort === null ? null : (
                <Button variant="ghost" size="sm" onClick={() => openUrl(macUrl(f.macPort as number))}>
                  Open
                </Button>
              )}
            </PageRow>
          ))
        : null}
      {runs ? (
        <SettingRow id="sharing.commands" saved={commands} description={nowWords(now.commands, now.waiting)}>
          <CommitField kind="int" aria-label={`Commands ${name} runs here at once`} value={host.maxRunning} min={1} max={MAC_BRIDGE_MAX_RUNNING_CAP} onCommit={limit(commands, "maxRunning")} />
        </SettingRow>
      ) : null}
      <SettingRow id="sharing.threads" saved={threads} description={nowWords(host.threads)}>
        <CommitField kind="int" aria-label={`Threads ${name} starts here at once`} value={host.maxThreads} min={0} max={MAC_BRIDGE_MAX_THREADS_CAP} onCommit={limit(threads, "maxThreads")} />
      </SettingRow>
      {host.computer ? (
        <SettingRow id="sharing.driven" saved={driven} description={nowWords(now.apps)}>
          <CommitField kind="int" aria-label={`Apps ${name} drives here at once`} value={host.maxComputer} min={1} max={MAC_BRIDGE_MAX_COMPUTER_CAP} onCommit={limit(driven, "maxComputer")} />
        </SettingRow>
      ) : null}
    </PageSection>
  );
}

/** The folders it reads with no approval: Remove acts at once (it only makes a read ask again); Add folder… opens a
 *  dialog naming the computer that will read it. */
function Folders({ host, name }: { host: MacBridgeHostPolicy; name: string }) {
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async (folders: string[]): Promise<boolean> => {
    setError(null);
    try {
      await setMacBridgeShared(host.environmentId, folders);
      return true;
    } catch (err) {
      setError(refusalWords(err));
      return false;
    }
  };
  return (
    <PageSection
      data-setting="sharing.folders"
      title={settingTitle("sharing.folders")}
      action={
        <Button variant="ghost" size="sm" onClick={() => setAdding(true)}>
          Add folder…
        </Button>
      }
    >
      {host.shared.length === 0 ? <PageEmpty>None</PageEmpty> : null}
      {host.shared.map((folder) => (
        <PageRow key={folder} data-folder={folder} title={<span className="block truncate font-mono text-xs font-normal">{folder}</span>}>
          <Button variant="ghost" size="sm" className="text-muted-foreground hover:text-destructive" onClick={() => void save(host.shared.filter((f) => f !== folder))}>
            Remove
          </Button>
        </PageRow>
      ))}
      {error ? <PageError>{error}</PageError> : null}
      {adding ? <AddFolderDialog name={name} onClose={() => setAdding(false)} onAdd={(folder) => save([...host.shared, folder])} /> : null}
    </PageSection>
  );
}

/** A folder for one computer to read without asking: a path typed or chosen; a refusal stays in the dialog. */
export function AddFolderDialog({ name, onClose, onAdd }: { name: string; onClose: () => void; onAdd: (folder: string) => Promise<boolean> }) {
  const [path, setPath] = useState("");
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const add = async (folder: string): Promise<void> => {
    setPending(true);
    setFailed(false);
    const landed = await onAdd(folder);
    setPending(false);
    if (landed) onClose();
    else setFailed(true);
  };
  return (
    <Modal onClose={onClose} busy={pending} title={`A folder ${name} reads without asking`} size="sm" data-add-folder="">
      <ModalBody>
        <div className="flex items-center gap-2">
          <Input
            autoFocus
            aria-label="Folder"
            value={path}
            placeholder="/Users/you/Documents/shared"
            spellCheck={false}
            autoComplete="off"
            className="flex-1 font-mono text-xs"
            onChange={(event) => setPath(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && path.trim()) void add(path.trim());
            }}
          />
          {isWebMode() ? null : (
            <Button variant="secondary" size="sm" onClick={() => void pickFolder(`A folder ${name} reads without asking`).then((picked) => (picked ? setPath(picked) : undefined))}>
              Choose…
            </Button>
          )}
        </div>
        {failed ? <ErrorLine error="It was not added. Try again." /> : null}
      </ModalBody>
      <DialogFooter onCancel={onClose} confirmLabel="Add" pending={pending} disabled={!path.trim()} onConfirm={() => void add(path.trim())} />
    </Modal>
  );
}

function Running({ host, name }: { host: MacBridgeHostPolicy; name: string }) {
  const running = useMacBridgeRunning({ environmentId: host.environmentId });
  return (
    <PageSection data-setting="sharing.running" title={settingTitle("sharing.running")}>
      {running.length === 0 ? <PageEmpty>Nothing</PageEmpty> : <MacBridgeRunningList environmentId={host.environmentId} hostName={name} />}
    </PageSection>
  );
}

/** What its threads were allowed until Docket quits, by thread: its rows wait in their shape, and a failed read is
 *  one line with Retry, never "Nothing". */
function Allowed({ environmentId }: { environmentId: string }) {
  const rules = useMacBridgeRules().filter((rule) => rule.environmentId === environmentId);
  const [state, setState] = useState<"reading" | "read" | "failed">("reading");
  const read = useCallback(
    () =>
      loadMacBridgeRules().then(
        () => setState("read"),
        () => setState("failed"),
      ),
    [],
  );
  useEffect(() => {
    void read();
  }, [read]);
  const threads = [...new Map(rules.map((rule) => [rule.sessionId, rule])).values()];
  return (
    <PageSection data-setting="sharing.allowed" title={settingTitle("sharing.allowed")}>
      {state === "reading" && threads.length === 0 ? <PageRowsSkeleton rows={1} control="none" /> : null}
      {state === "failed" && threads.length === 0 ? (
        <PageError
          action={
            <Button variant="ghost" size="sm" onClick={() => void read()}>
              Retry
            </Button>
          }
        >
          {`${thisDesktopInLine().replace(/^t/, "T")} did not answer.`}
        </PageError>
      ) : null}
      {state === "read" && threads.length === 0 ? <PageEmpty>Nothing</PageEmpty> : null}
      {threads.map((rule) => (
        <MacBridgeRuleList key={rule.sessionId} sessionId={rule.sessionId} heading={<span className="min-w-0 truncate font-medium text-foreground">{rule.threadTitle || "A thread with no title"}</span>} />
      ))}
    </PageSection>
  );
}
