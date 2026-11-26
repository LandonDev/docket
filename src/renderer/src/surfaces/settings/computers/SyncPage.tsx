import { useState } from "react";
import type { HarnessSyncStatus } from "@server/shared/contract-harness";
import type { MemorySyncStatus } from "@server/shared/contract-memory";
import { PageEmpty, PageRow, PageSection } from "../../../components/page";
import { SettingSwitch } from "../../../components/setting-switch";
import { BusyLabel, Button } from "../../../components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../../components/ui/tooltip";
import { confirmAction } from "../../../chrome/ConfirmDialog";
import { Modal, ModalBody } from "../../../chrome/Modal";
import { registry } from "../../../lib/connection";
import { useHostRead, type HostRead } from "../../../lib/connection/hostRead";
import { revealPath } from "../../../lib/fs";
import { thisDesktopInLine } from "../../../lib/native";
import { useComputerNames, computerInLine } from "../../../lib/settings/computerName";
import { refusalWords } from "../../../lib/settingsHome";
import { ago, harnessParts } from "../../harnessLine";
import { memoryParts } from "../../memoryLine";
import { ComputerName } from "../parts/ComputerName";
import { SettingRow, SettingSection } from "../parts/SettingRow";
import { useSaved } from "../parts/useSaved";
import { SectionRead } from "./read";

/** "the box", "the box and PURDUE-LT", "the box, PURDUE-LT and MacBook Air". */
export function namesWords(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/** What this Mac syncs, read from this window's own server; the agents' memory may be missing on an older one. */
function useSync(): { harness: HostRead<HarnessSyncStatus>; memory: HostRead<MemorySyncStatus | null> } {
  const link = registry.primary();
  const harness = useHostRead<HarnessSyncStatus>(link, () => link.request<HarnessSyncStatus>("harness.status", {}), "harness");
  const memory = useHostRead<MemorySyncStatus | null>(link, () => link.request<MemorySyncStatus>("memory.status", {}).catch(() => null), "memory");
  return { harness, memory };
}

/** The computers the sync reaches, each in a sentence: every computer either leg names, by id, in order. */
function useSyncedNames(harness: HarnessSyncStatus | undefined, memory: MemorySyncStatus | null | undefined): { id: string; said: string }[] {
  const names = useComputerNames();
  const seen = new Map<string, string>();
  for (const env of [...(harness?.environments ?? []), ...(memory?.environments ?? [])]) if (!seen.has(env.id)) seen.set(env.id, env.name);
  return [...seen].map(([id, said]) => ({ id, said: computerInLine(names(id, said)) }));
}

/** The page's line, under its title: which computers this Mac keeps the same as itself. */
export function SyncLine() {
  const { harness, memory } = useSync();
  const names = useSyncedNames(harness.value, memory.value);
  if (!harness.value || names.length === 0) return null;
  return <>{`${capital(thisDesktopInLine())} keeps ${namesWords(names.map((n) => n.said))} the same as itself.`}</>;
}

const COUNTS = ["", "", "", "three", "four", "five", "six", "seven", "eight", "nine"];
/** "Kept the same on all three, both ways": the computers counted with this one; two need no count. */
export const memoryWords = (computers: number): string =>
  computers <= 2 ? "Kept the same both ways" : `Kept the same on all ${COUNTS[computers] ?? computers}, both ways`;

const capital = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

/**
 * Settings › Sync (docs/agents/settings.md "The pages: computers"): this Mac's agent settings going out to the
 * computers it manages and the agents' memory kept the same both ways, each a switch on this Mac's own server; when
 * each computer last synced, with Sync now; the conflict copies in a dialog, only while there are any. Turning the
 * agent settings on asks first, naming every computer that receives them.
 */
export function SyncPage() {
  const { harness, memory } = useSync();
  const names = useSyncedNames(harness.value, memory.value);
  return (
    <SectionRead read={harness} rows={[{ description: true, control: "switch" }, { description: true, control: "switch" }]}>
      {(value) => <SyncBody harness={value} memory={memory.value ?? null} names={names.map((n) => n.said)} onHarness={harness.set} onMemory={memory.set} />}
    </SectionRead>
  );
}

function SyncBody({
  harness,
  memory,
  names,
  onHarness,
  onMemory,
}: {
  harness: HarnessSyncStatus;
  memory: MemorySyncStatus | null;
  names: string[];
  onHarness: (s: HarnessSyncStatus) => void;
  onMemory: (s: MemorySyncStatus | null) => void;
}) {
  const settings = useSaved();
  const memorySaved = useSaved();
  const [conflicts, setConflicts] = useState(false);
  const link = registry.primary();
  const mac = capital(thisDesktopInLine());
  const to = namesWords(names);
  const stay = harness.skipped > 0 ? ` ${harness.skipped} ${harness.skipped === 1 ? "file stays" : "files stay"} here.` : "";
  const setHarness = async (enabled: boolean): Promise<boolean> => {
    if (enabled && names.length > 0) {
      const ok = await confirmAction({
        title: `Send ${thisDesktopInLine()}'s agent settings to ${to}?`,
        body: `${names.length === 1 ? "It gets" : "Each gets"} ${thisDesktopInLine()}'s Claude Code and Codex settings, and again each time they change.`,
        action: "Send",
      });
      if (!ok) return false;
    }
    return settings.run(async () => onHarness(await link.request<HarnessSyncStatus>("harness.settings.set", { enabled })));
  };
  // One row a computer, whichever leg names it.
  const rows = new Map<string, { id: string; name: string; connected: boolean; running: boolean; harnessLine: string | null; memoryLine: string | null }>();
  for (const env of harness.environments) rows.set(env.id, { id: env.id, name: env.name, connected: env.connected, running: env.running, harnessLine: harnessParts(env).join(", "), memoryLine: null });
  for (const mem of memory?.environments ?? []) {
    const row = rows.get(mem.id) ?? { id: mem.id, name: mem.name, connected: mem.connected, running: false, harnessLine: null, memoryLine: null };
    rows.set(mem.id, { ...row, running: row.running || mem.running, memoryLine: memoryParts(mem).join(", ") });
  }
  const count = memory?.conflicts.length ?? 0;
  return (
    <>
      <PageSection>
        <SettingRow id="sync.settings" saved={settings} description={to ? `${mac}'s Claude Code and Codex settings go to ${to}.${stay}` : undefined}>
          <SettingSwitch label="Agent settings" on={harness.enabled} onChange={setHarness} />
        </SettingRow>
        {memory ? (
          <SettingRow id="sync.memory" saved={memorySaved} description={memoryWords(names.length + 1)}>
            <SettingSwitch
              label="Agents' memory"
              on={memory.enabled}
              onChange={(enabled) => memorySaved.run(async () => onMemory(await link.request<MemorySyncStatus>("memory.settings.set", { enabled })))}
            />
          </SettingRow>
        ) : null}
        {count > 0 ? (
          <SettingRow id="sync.conflicts" description={`${count} kept beside the notes they differ from`} onOpen={() => setConflicts(true)} openLabel="Conflict copies" />
        ) : null}
      </PageSection>
      <SettingSection of="sync.last">
        {rows.size === 0 ? <PageEmpty>No other computer is linked</PageEmpty> : null}
        {[...rows.values()].map((row) => (
          <LastSynced
            key={row.id}
            id={row.id}
            name={row.name}
            harnessLine={row.harnessLine}
            memoryLine={row.memoryLine}
            reachable={row.connected}
            running={row.running}
            harnessOn={harness.enabled}
            memoryOn={memory?.enabled ?? false}
            onSynced={(h, m) => {
              if (h) onHarness(h);
              if (m) onMemory(m);
            }}
          />
        ))}
      </SettingSection>
      {conflicts && memory ? <ConflictsDialog memory={memory} onClose={() => setConflicts(false)} /> : null}
    </>
  );
}

function LastSynced({
  id,
  name,
  harnessLine,
  memoryLine,
  reachable,
  running,
  harnessOn,
  memoryOn,
  onSynced,
}: {
  id: string;
  name: string;
  harnessLine: string | null;
  memoryLine: string | null;
  reachable: boolean;
  running: boolean;
  harnessOn: boolean;
  memoryOn: boolean;
  onSynced: (harness: HarnessSyncStatus | null, memory: MemorySyncStatus | null) => void;
}) {
  const names = useComputerNames();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const link = registry.primary();
  const sync = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const h = harnessOn ? await link.request<HarnessSyncStatus>("harness.sync", { environmentId: id }) : null;
      const m = memoryOn ? await link.request<MemorySyncStatus>("memory.sync", { environmentId: id }) : null;
      onSynced(h, m);
    } catch (err) {
      setError(refusalWords(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <PageRow
      data-synced={id}
      title={<ComputerName computer={names(id, name)} />}
      description={
        <>
          {harnessLine && harnessOn ? <span className="block">Agent settings: {harnessLine}</span> : null}
          {memoryLine && memoryOn ? <span className="block">Memory: {memoryLine}</span> : null}
        </>
      }
      error={error ?? undefined}
    >
      <Button variant="ghost" size="sm" disabled={(!harnessOn && !memoryOn) || !reachable || running || busy} onClick={() => void sync()}>
        <BusyLabel busy={busy || running} label="Sync now" />
      </Button>
    </PageRow>
  );
}

/** The conflict copies the memory sync kept on this Mac, newest first, each with Reveal. */
function ConflictsDialog({ memory, onClose }: { memory: MemorySyncStatus; onClose: () => void }) {
  return (
    <Modal onClose={onClose} title="Conflict copies" description="Each was kept beside the note it differs from." size="sm">
      <ModalBody>
        {memory.conflicts.map((c) => (
          <PageRow key={c.path} title={<span className="block truncate font-mono text-xs font-normal">{c.of}</span>} description={`${c.host}'s copy, ${ago(c.at)}`}>
            <Tooltip>
              <TooltipTrigger render={<Button variant="ghost" size="sm" onClick={() => void revealPath(c.path)} />}>Reveal</TooltipTrigger>
              <TooltipContent className="font-mono">{c.path}</TooltipContent>
            </Tooltip>
          </PageRow>
        ))}
      </ModalBody>
    </Modal>
  );
}
