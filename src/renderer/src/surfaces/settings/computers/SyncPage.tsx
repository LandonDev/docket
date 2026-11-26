import { useState } from "react";
import type { HarnessEnvironmentStatus, HarnessSyncStatus } from "@server/shared/contract-harness";
import type { MemoryEnvironmentStatus, MemorySyncStatus } from "@server/shared/contract-memory";
import { PageEmpty, PageRow, PageRowsSkeleton, PageSection } from "../../../components/page";
import { SettingSwitch } from "../../../components/setting-switch";
import { BusyLabel, Button } from "../../../components/ui/button";
import { Skeleton } from "../../../components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../../components/ui/tooltip";
import { confirmAction } from "../../../chrome/ConfirmDialog";
import { Modal, ModalBody } from "../../../chrome/Modal";
import { LOCAL_ENVIRONMENT_ID, registry } from "../../../lib/connection";
import { useHostRead, type HostRead } from "../../../lib/connection/hostRead";
import { revealPath } from "../../../lib/fs";
import { thisDesktopInLine } from "../../../lib/native";
import { useComputerNames, computerInLine, useReadFailWords } from "../../../lib/settings/computerName";
import { refusalWords } from "../../../lib/settingsHome";
import { ago } from "../../harnessLine";
import { ComputerName } from "../parts/ComputerName";
import { SettingRow, SettingSection } from "../parts/SettingRow";
import { useSaved } from "../parts/useSaved";
import { SectionRead } from "./read";

/** "the box", "the box and PURDUE-LT", "the box, PURDUE-LT and MacBook Air". */
export function namesWords(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/** A server from before memory sync does not know the method: that alone means it has none. Any other refusal is a
 *  failed read, said with Retry. */
export const noMemorySync = (err: unknown): boolean => /unknown method|bad request|invalid request/i.test(err instanceof Error ? err.message : String(err));

/** What this Mac syncs, read from this window's own server; the agents' memory is `null` only on one without it. */
function useSync(): { harness: HostRead<HarnessSyncStatus>; memory: HostRead<MemorySyncStatus | null> } {
  const link = registry.primary();
  const harness = useHostRead<HarnessSyncStatus>(link, () => link.request<HarnessSyncStatus>("harness.status", {}), "harness");
  const memory = useHostRead<MemorySyncStatus | null>(
    link,
    () =>
      link.request<MemorySyncStatus>("memory.status", {}).catch((err: unknown) => {
        if (noMemorySync(err)) return null;
        throw err;
      }),
    "memory",
  );
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
  // While the read is out the line holds its place, so the title block does not move when it lands.
  if (harness.value === undefined && !harness.error) return <span data-slot="skeleton" aria-label="Loading" className="inline-block h-3 w-64 rounded-md bg-skeleton align-middle" />;
  if (!harness.value || names.length === 0) return null;
  return <>{`${capital(thisDesktopInLine())} keeps ${namesWords(names.map((n) => n.said))} the same as itself.`}</>;
}

/** A failed read's Retry on its own row: it spins until the read it asked settles. */
function RetryButton({ retry }: { retry: () => Promise<void> }) {
  const [retrying, setRetrying] = useState(false);
  return (
    <Button
      variant="ghost"
      size="sm"
      disabled={retrying}
      onClick={() => {
        setRetrying(true);
        void retry().finally(() => setRetrying(false));
      }}
    >
      <BusyLabel busy={retrying} label="Retry" />
    </Button>
  );
}

/** "1 note differs. Both copies are kept.": the conflict copies in his words. */
export const conflictWords = (count: number): string =>
  count === 1 ? "1 note differs. Both copies are kept." : `${count} notes differ. Both copies of each are kept.`;

const plural = (n: number, one: string): string => `${n} ${one}${n === 1 ? "" : "s"}`;

/**
 * One computer's last sync as one comma sentence ("212 agent settings files and 48 memory files, synced 2m ago"):
 * the legs that are on, the newer of their times; a leg's failure is the row's red line.
 */
export function syncedWords(settings: HarnessEnvironmentStatus | null, memory: MemoryEnvironmentStatus | null, now = Date.now()): { words: string; error: string | null } {
  const legs = [settings, memory].filter((leg): leg is HarnessEnvironmentStatus | MemoryEnvironmentStatus => leg !== null);
  if (legs.length === 0) return { words: "Nothing syncs", error: null };
  if (legs.some((leg) => leg.running)) return { words: "Syncing…", error: null };
  const error = legs.find((leg) => leg.error)?.error ?? null;
  const at = Math.max(...legs.map((leg) => leg.syncedAt ?? 0));
  if (!at) return { words: "Never synced", error };
  const files = [
    settings?.files != null ? plural(settings.files, "agent settings file") : null,
    memory?.files != null ? plural(memory.files, "memory file") : null,
  ].filter(Boolean);
  const what = files.length ? `${files.join(" and ")}, ` : "";
  return { words: `${what}synced ${ago(at, now)}`, error };
}

const COUNTS = ["", "", "", "three", "four", "five", "six", "seven", "eight", "nine"];
/** "Kept the same on all three, both ways.": the computers counted with this one; two need no count. A sentence with
 *  its stop, as the agent settings line beside it and the conflict line under it are. */
export const memoryWords = (computers: number): string =>
  computers <= 2 ? "Kept the same both ways." : `Kept the same on all ${COUNTS[computers] ?? computers}, both ways.`;

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
  // While the first read is out the page stands in its shape: the two switches, and Last synced with its rows.
  if (harness.value === undefined && !harness.error)
    return (
      <>
        <PageSection>
          <PageRowsSkeleton rows={[{ description: true, control: "switch" }, { description: true, control: "switch" }]} />
        </PageSection>
        <SettingSection of="sync.last">
          <PageRowsSkeleton rows={2} description control="button" />
        </SettingSection>
      </>
    );
  return (
    <SectionRead read={harness} computer={LOCAL_ENVIRONMENT_ID} rows={1}>
      {(value) => <SyncBody harness={value} memoryRead={memory} names={names.map((n) => n.said)} onHarness={harness.set} onMemory={memory.set} />}
    </SectionRead>
  );
}

function SyncBody({
  harness,
  memoryRead,
  names,
  onHarness,
  onMemory,
}: {
  harness: HarnessSyncStatus;
  /** Agents' memory, its own read: out, failed, `null` on a server without it, or its status. */
  memoryRead: HostRead<MemorySyncStatus | null>;
  names: string[];
  onHarness: (s: HarnessSyncStatus) => void;
  onMemory: (s: MemorySyncStatus | null) => void;
}) {
  const memory = memoryRead.value ?? null;
  const readWords = useReadFailWords(LOCAL_ENVIRONMENT_ID);
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
  const rows = new Map<string, { id: string; name: string; connected: boolean; harness: HarnessEnvironmentStatus | null; memory: MemoryEnvironmentStatus | null }>();
  for (const env of harness.environments) rows.set(env.id, { id: env.id, name: env.name, connected: env.connected, harness: env, memory: null });
  for (const mem of memory?.environments ?? []) {
    const row = rows.get(mem.id) ?? { id: mem.id, name: mem.name, connected: mem.connected, harness: null, memory: null };
    rows.set(mem.id, { ...row, memory: mem });
  }
  const count = memory?.conflicts.length ?? 0;
  return (
    <>
      <PageSection>
        <SettingRow id="sync.settings" saved={settings} description={`${mac}'s Claude Code and Codex settings.${stay}`}>
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
        ) : memoryRead.value === null ? null : memoryRead.error ? (
          // Its own read failed: the row stays, saying so with its own Retry, so the way back to the switch is here.
          <SettingRow id="sync.memory" error={readWords(memoryRead.error)}>
            <RetryButton retry={memoryRead.retry} />
          </SettingRow>
        ) : (
          // Its own read is out: the row holds its place, its line and switch as bones.
          <SettingRow id="sync.memory" description={<span data-slot="skeleton" aria-label="Loading" className="inline-block h-3 w-48 rounded-md bg-skeleton align-middle" />}>
            <Skeleton data-skeleton-control className="h-[18px] w-8 shrink-0 rounded-full" />
          </SettingRow>
        )}
        {count > 0 ? (
          <SettingRow id="sync.conflicts" description={conflictWords(count)} onOpen={() => setConflicts(true)} openLabel="Conflict copies" />
        ) : null}
      </PageSection>
      <SettingSection of="sync.last">
        {rows.size === 0 ? <PageEmpty>No other computer is linked</PageEmpty> : null}
        {[...rows.values()].map((row) => (
          <LastSynced
            key={row.id}
            id={row.id}
            name={row.name}
            line={syncedWords(harness.enabled ? row.harness : null, memory?.enabled ? row.memory : null)}
            reachable={row.connected}
            running={row.harness?.running === true || row.memory?.running === true}
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
  line,
  reachable,
  running,
  harnessOn,
  memoryOn,
  onSynced,
}: {
  id: string;
  name: string;
  line: { words: string; error: string | null };
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
      description={line.words}
      error={error ?? line.error ?? undefined}
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
