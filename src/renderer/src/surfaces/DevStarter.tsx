import { useEffect, useState } from "react";
import type { DevTarget } from "@server/shared/contract-devservers";
import { useLinkMay } from "../lib/linkMayCore";
import { useHostHeld } from "../lib/connection/degraded";
import { HeldTip } from "../components/heldTip";
import { ChoiceSelect } from "../components/choice-select";
import { BusyLabel, Button } from "../components/ui/button";
import { Region } from "../components/bones";
import { ChoiceToggle } from "../components/choice-toggle";
import { devPane } from "../lib/devPane";
import { dialogErrorWords } from "../lib/dialogErrorWords";
import {
  runChoice,
  startDevServer,
  stopLiveServer,
  targetLabel,
  threadRoot,
  useDevHosts,
  useDevTargets,
  useLiveDevServers,
  type DevHost,
} from "../lib/devServers";
import { useServerSessions } from "../lib/tcserver/store";
import { useProjects } from "../lib/tcserver/workspaces";
import { useActivePane } from "../stores/project";

const targetKey = (projectId: string): string => `dev-target:${projectId}`;
const hostKey = (projectId: string): string => `dev-host:${projectId}`;

export type DevStarterState = {
  hosts: DevHost[];
  /** The host the next run starts on. */
  envId: string | null;
  pickHost: (id: string) => void;
  /** undefined while loading, null when the host cannot say. */
  targets: DevTarget[] | null | undefined;
  target: DevTarget | undefined;
  pickTarget: (id: string) => void;
  starting: boolean;
  error: string | null;
  /** Run pressed for a thread that already has a dev server: the choice waits. */
  asking: boolean;
  /** Start the target for the thread on screen; asks first when that thread already runs one. */
  run: () => Promise<void>;
  /** The answer: stop the thread's servers and start this one, or start another beside them. */
  answer: (choice: "replace" | "another" | "cancel") => Promise<void>;
};

/**
 * What the project can serve and on which host (docs/box.md "Dev servers on
 * the box"). Run starts the target for the thread on screen and picks it in
 * the Dev servers pane; a thread has one dev server unless the person says
 * the second is for a different feature (`runChoice`).
 */
export function useDevStarter(projectId: string | null): DevStarterState {
  const project = useProjects().find((p) => p.id === projectId);
  const hosts = useDevHosts(project);
  const [hostPick, setHostPick] = useState<string | null>(() => (projectId ? localStorage.getItem(hostKey(projectId)) : null));
  const host = hosts.find((h) => h.environmentId === hostPick && h.projectId) ?? hosts[0];
  const envId = host?.environmentId ?? null;
  const copyId = host?.projectId ?? null;
  const targets = useDevTargets(envId, copyId);
  const [targetPick, setTargetPick] = useState<string | null>(() => (projectId ? localStorage.getItem(targetKey(projectId)) : null));
  const target = targets?.find((t) => t.id === targetPick) ?? targets?.[0];
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const servers = useLiveDevServers();
  const sessions = useServerSessions();
  const active = useActivePane().active;
  const sessionId = active
    ? threadRoot(active.id, (id) => sessions.find((s) => s.id === id)?.parentId ?? (id === active.id ? active.parentId : null))
    : null;
  // The question is about the thread it was asked for: switching threads drops it.
  useEffect(() => setAsking(false), [sessionId]);

  const start = async (mode: "plain" | "replace" | "another"): Promise<void> => {
    if (!envId || !copyId || !target) return;
    setStarting(true);
    setError(null);
    try {
      if (mode === "replace") await Promise.all(servers.filter((s) => s.sessionId === sessionId).map((s) => stopLiveServer(s)));
      const started = await startDevServer(envId, copyId, target.id, sessionId, mode === "replace" ? { replace: true } : mode === "another" ? { another: true } : {});
      // The host knows a server of this thread the pane did not (a port row filed since): the same question.
      if ("replace" in started) {
        setAsking(true);
        return;
      }
      devPane.open(`${envId}/${started.id}`);
    } catch (err) {
      // In a person's words, the host by its name; never the host's raw text.
      setError(dialogErrorWords(err, host?.name));
    } finally {
      setStarting(false);
    }
  };

  return {
    hosts,
    envId,
    targets,
    target,
    starting,
    error,
    pickHost: (id) => {
      if (projectId) localStorage.setItem(hostKey(projectId), id);
      setHostPick(id);
      setError(null);
    },
    pickTarget: (id) => {
      if (projectId) localStorage.setItem(targetKey(projectId), id);
      setTargetPick(id);
      setError(null);
    },
    asking,
    run: async () => {
      if (runChoice(servers, sessionId) === "ask") setAsking(true);
      else await start("plain");
    },
    answer: async (choice) => {
      setAsking(false);
      if (choice !== "cancel") await start(choice === "replace" ? "replace" : "another");
    },
  };
}

/** The Dev servers pane's starter: the target, Run, and with two or more hosts the host to run on. */
export function DevStarter({ starter }: { starter: DevStarterState }) {
  const { hosts, envId, targets, target, starting, error } = starter;
  const mayRun = useLinkMay(envId ?? "", "devServer.start");
  const held = useHostHeld(envId ?? undefined);
  const options = (targets ?? []).map((t) => ({ value: t.id, label: targetLabel(t) }));
  return (
    <div data-dev-starter="" className="flex shrink-0 flex-col border-b border-border">
      <div className="flex h-9 items-center gap-2 px-3">
        {targets === undefined ? (
          // The targets' read: the field itself, disabled, on a sample target while it is out.
          <Region loading label="Loading dev server targets" className="flex-1" bones={SampleTargetField} />
        ) : options.length > 0 ? (
          <ChoiceSelect
            label="Dev server target"
            size="sm"
            value={target?.id ?? options[0].value}
            options={options}
            disabled={options.length < 2}
            onChange={starter.pickTarget}
            className="min-w-0 flex-1"
          />
        ) : (
          <ChoiceSelect label="Dev server target" size="sm" value="" options={NO_TARGETS} disabled onChange={noop} className="min-w-0 flex-1" />
        )}
        {/* D5: Run asks the host; held while its link is not open, not drawn for a key that may not start a server. */}
        {mayRun ? (
          <HeldTip held={held}>
            <Button size="sm" disabled={!target || !envId || starting || starter.asking || !!held} onClick={() => void starter.run()}>
              <BusyLabel busy={starting} label="Run" />
            </Button>
          </HeldTip>
        ) : null}
      </div>
      {starter.asking ? (
        <div data-dev-replace="" className="flex flex-col gap-2 px-3 pb-2">
          <p className="text-xs text-muted-foreground">This thread already runs a dev server.</p>
          <div className="flex gap-1">
            <Button size="xs" onClick={() => void starter.answer("replace")}>
              Replace
            </Button>
            <Button size="xs" variant="secondary" onClick={() => void starter.answer("another")}>
              Start another
            </Button>
            <Button size="xs" variant="ghost" onClick={() => void starter.answer("cancel")}>
              Cancel
            </Button>
          </div>
        </div>
      ) : null}
      {hosts.length > 1 ? <HostChoice hosts={hosts} value={envId} onChange={starter.pickHost} /> : null}
      {error ? <p className="break-words px-3 pb-2 text-xs text-destructive">{error}</p> : null}
    </div>
  );
}

const NO_TARGETS = [{ value: "", label: "No targets" }];
const SAMPLE_TARGETS = [{ value: "sample:dev", label: "bun run dev" }];

/** The target field at rest, from a sample: what the targets' bones are drawn from. */
function SampleTargetField() {
  return <ChoiceSelect label="Dev server target" size="sm" value={SAMPLE_TARGETS[0].value} options={SAMPLE_TARGETS} disabled onChange={noop} className="min-w-0 flex-1" />;
}
const noop = () => {};

/** Mac or box: the hosts with a copy of the project; one with no project for it shows held, saying why. */
function HostChoice({ hosts, value, onChange }: { hosts: DevHost[]; value: string | null; onChange: (id: string) => void }) {
  return (
    <div className="px-3 pb-2">
      <ChoiceToggle
        label="Run on"
        value={value ?? ""}
        onChange={onChange}
        options={hosts.map((h) => (h.projectId ? { value: h.environmentId, label: h.name } : { value: h.environmentId, label: h.name, disabled: true, note: `${h.name} has the folder but no project for it` }))}
      />
    </div>
  );
}
