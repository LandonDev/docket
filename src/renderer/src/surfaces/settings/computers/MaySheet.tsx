import { useEffect, useState } from "react";
import {
  MAC_BRIDGE_MAX_COMPUTER_CAP,
  MAC_BRIDGE_MAX_RUNNING_CAP,
  MAC_BRIDGE_MAX_THREADS_CAP,
  type MacBridgeHostPolicy,
  type MacBridgePolicy,
} from "@server/shared/contract-macbridge";
import { PageEmpty, PageError, PageRow, PageSection } from "../../../components/page";
import { SettingSwitch } from "../../../components/setting-switch";
import { Button } from "../../../components/ui/button";
import { GroupInput, InputGroup } from "../../../components/ui/input";
import { RadioChoice, RadioGroup } from "../../../components/ui/radio-group";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "../../../components/ui/sheet";
import { confirmAction } from "../../../chrome/ConfirmDialog";
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
import { useComputerNames } from "../../../lib/settings/computerName";
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
  const name = useComputerNames()(host.environmentId, host.name).name;
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
  const choose = async (next: MacBridgePolicy): Promise<void> => {
    const ending = host.running + host.held;
    if (rank(next) < rank(host.policy) && ending > 0) {
      const ok = await confirmAction({
        title: `Lower what ${name} may do on ${mac}?`,
        body: `${plural(ending, "command it runs here ends", "commands it runs here end")}.`,
        action: "Lower",
        danger: true,
      });
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
      <LimitRows host={host} name={name} mac={mac} policy={policy} />
      {policy === "off" ? null : <Folders host={host} name={name} />}
      <Running host={host} name={name} />
      <Allowed environmentId={host.environmentId} />
    </>
  );
}

function LimitRows({ host, name, mac, policy }: { host: MacBridgeHostPolicy; name: string; mac: string; policy: MacBridgePolicy }) {
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
    } else if (host.computerLive > 0) {
      const ok = await confirmAction({
        title: `Stop ${name} using ${mac}'s apps?`,
        body: `${plural(host.computerLive, "live session ends", "live sessions end")}.`,
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
        <SettingRow id="sharing.commands" saved={commands} description={host.held > 0 ? `${host.running} running, ${host.held} waiting` : `${host.running} running`}>
          <CommitField kind="int" aria-label={`Commands ${name} runs here at once`} value={host.maxRunning} min={1} max={MAC_BRIDGE_MAX_RUNNING_CAP} onCommit={limit(commands, "maxRunning")} />
        </SettingRow>
      ) : null}
      <SettingRow id="sharing.threads" saved={threads} description={plural(host.threads, "thread here now", "threads here now")}>
        <CommitField kind="int" aria-label={`Threads ${name} starts here at once`} value={host.maxThreads} min={0} max={MAC_BRIDGE_MAX_THREADS_CAP} onCommit={limit(threads, "maxThreads")} />
      </SettingRow>
      {host.computer ? (
        <SettingRow id="sharing.driven" saved={driven} description={`${host.computerLive} live now`}>
          <CommitField kind="int" aria-label={`Apps ${name} drives here at once`} value={host.maxComputer} min={1} max={MAC_BRIDGE_MAX_COMPUTER_CAP} onCommit={limit(driven, "maxComputer")} />
        </SettingRow>
      ) : null}
    </PageSection>
  );
}

/** The folders it reads with no approval: Remove acts at once (it only makes a read ask again); Add takes a path or
 *  Choose… a folder. */
function Folders({ host, name }: { host: MacBridgeHostPolicy; name: string }) {
  const [path, setPath] = useState("");
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
  const add = async (folder: string): Promise<void> => {
    if (await save([...host.shared, folder])) setPath("");
  };
  return (
    <PageSection data-setting="sharing.folders" title={settingTitle("sharing.folders")}>
      {host.shared.length === 0 ? <PageEmpty>None</PageEmpty> : null}
      {host.shared.map((folder) => (
        <PageRow key={folder} data-folder={folder} title={<span className="block truncate font-mono text-xs font-normal">{folder}</span>}>
          <Button variant="ghost" size="sm" className="text-muted-foreground hover:text-destructive" onClick={() => void save(host.shared.filter((f) => f !== folder))}>
            Remove
          </Button>
        </PageRow>
      ))}
      <form
        className="flex items-center gap-2 pt-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (path.trim()) void add(path.trim());
        }}
      >
        <InputGroup className="flex-1">
          <GroupInput aria-label="A folder to read without asking" value={path} placeholder="/Users/you/Documents/shared" spellCheck={false} autoComplete="off" className="font-mono text-xs" onChange={(event) => setPath(event.target.value)} />
        </InputGroup>
        <Button type="submit" variant="secondary" size="sm" disabled={!path.trim()}>
          Add
        </Button>
        {isWebMode() ? null : (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => void pickFolder(`A folder ${name} reads without asking`).then((picked) => (picked ? add(picked) : undefined))}
          >
            Choose…
          </Button>
        )}
      </form>
      {error ? <PageError>{error}</PageError> : null}
    </PageSection>
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

/** What its threads were allowed until Docket quits, by thread. */
function Allowed({ environmentId }: { environmentId: string }) {
  const rules = useMacBridgeRules().filter((rule) => rule.environmentId === environmentId);
  useEffect(() => {
    void loadMacBridgeRules().catch(() => null);
  }, []);
  const threads = [...new Map(rules.map((rule) => [rule.sessionId, rule])).values()];
  return (
    <PageSection data-setting="sharing.allowed" title={settingTitle("sharing.allowed")}>
      {threads.length === 0 ? <PageEmpty>Nothing</PageEmpty> : null}
      {threads.map((rule) => (
        <MacBridgeRuleList key={rule.sessionId} sessionId={rule.sessionId} heading={<span className="min-w-0 truncate font-medium text-foreground">{rule.threadTitle || rule.sessionId}</span>} />
      ))}
    </PageSection>
  );
}
