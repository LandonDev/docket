import { useEffect, useState } from "react";
import { ReadFailure } from "./parts/ReadFailure";
import type { KeepAwakeStatusWire } from "@server/shared/contract-power";
import { InboxProviderMark } from "../../chrome/InboxProviderMark";
import { DialogFooter, confirmAction } from "../../chrome/ConfirmDialog";
import { Field } from "../../chrome/DialogField";
import { ModalBody, ModalPanel } from "../../chrome/Modal";
import { ChoiceSelect } from "../../components/choice-select";
import { PageRowsSkeleton } from "../../components/page";
import { SettingSwitch } from "../../components/setting-switch";
import { Button } from "../../components/ui/button";
import { Dialog } from "../../components/ui/dialog";
import { Input } from "../../components/ui/input";
import { loadTranscriptAnchor, saveTranscriptAnchor, TRANSCRIPT_ANCHOR_CHANGE_EVENT } from "../../lib/appearance";
import { registry } from "../../lib/connection";
import { useHostRead } from "../../lib/connection/hostRead";
import { clearInboxCache } from "../../lib/githubTasks";
import { keyCaps } from "../../lib/keys";
import {
  disconnectLinear,
  linearConnected,
  listLinearTeams,
  loadHiddenLinearTeamIds,
  notifyLinearChange,
  saveHiddenLinearTeamIds,
  saveLinearToken,
  type LinearTeam,
} from "../../lib/linear";
import { isWebMode, thisDesktopInLine } from "../../lib/native";
import { computerInLine, useComputerName } from "../../lib/settings/computerName";
import { loadMidTurnDefault, saveMidTurnDefault, type MidTurnDefault } from "../../lib/settings";
import { loadSoundsEnabled, saveSoundsEnabled } from "../../lib/sounds";
import { Keys } from "./keys";
import { SettingRow, SettingSection } from "./parts/SettingRow";
import { useSaved } from "./parts/useSaved";
import { SwitchListDialog } from "./parts/SwitchListDialog";
import { PickerRow } from "./PickerSettings";

const MOD_ENTER = keyCaps("mod+return");

/** A stored flag kept in this window: the control moves at once and nothing is sent. */
function useStoredFlag(load: () => boolean, save: (on: boolean) => void): [boolean, (on: boolean) => void] {
  const [on, setOn] = useState(load);
  return [
    on,
    (next) => {
      save(next);
      setOn(next);
    },
  ];
}

/**
 * Settings › General (docs/agents/settings.md "This Mac"): the transcript, the composer, sounds and this Mac's power,
 * and the inbox's Linear sign-in. The rows kept in this window (the prompt, Enter, the picker, Sounds, Linear's teams)
 * show a change at once; Keep this Mac awake and Linear ask the computer and say its answer.
 */
export function GeneralPage() {
  const [transcriptAnchor, setTranscriptAnchor] = useState(loadTranscriptAnchor);
  const [midTurn, setMidTurn] = useState<MidTurnDefault>(loadMidTurnDefault);
  const [sounds, setSounds] = useStoredFlag(loadSoundsEnabled, saveSoundsEnabled);

  // The menu flips the anchor too; follow it while the page is open.
  useEffect(() => {
    const onAnchor = (event: Event) => setTranscriptAnchor((event as CustomEvent<boolean>).detail === true);
    window.addEventListener(TRANSCRIPT_ANCHOR_CHANGE_EVENT, onAnchor);
    return () => window.removeEventListener(TRANSCRIPT_ANCHOR_CHANGE_EVENT, onAnchor);
  }, []);

  return (
    <>
      <SettingSection of="general.promptTop">
        <SettingRow id="general.promptTop">
          <SettingSwitch
            label="Keep my prompt at the top"
            on={transcriptAnchor}
            onChange={(next) => {
              saveTranscriptAnchor(next);
              setTranscriptAnchor(next);
            }}
          />
        </SettingRow>
      </SettingSection>

      <SettingSection of="general.enter">
        <SettingRow
          id="general.enter"
          description={
            <>
              Steer sends into the running turn, Queue waits for it.
              <Keys keys={MOD_ENTER} />
              does the other.
            </>
          }
        >
          <ChoiceSelect
            label="Enter while a thread is working"
            value={midTurn}
            options={[
              { value: "steer", label: "Steer" },
              { value: "queue", label: "Queue" },
            ]}
            onChange={(next) => {
              saveMidTurnDefault(next);
              setMidTurn(next);
            }}
          />
        </SettingRow>
        <PickerRow />
      </SettingSection>

      <SettingSection of="general.sounds">
        <SettingRow id="general.sounds">
          <SettingSwitch label="Sounds" on={sounds} onChange={setSounds} />
        </SettingRow>
        {/* The page at /ui is a browser's: it has no computer of its own to keep awake. */}
        {isWebMode() ? null : <KeepAwakeRow />}
      </SettingSection>

      <LinearSection />
    </>
  );
}

export const KEEP_AWAKE_OPTIONS: { value: KeepAwakeStatusWire["mode"]; label: string }[] = [
  { value: "while-working", label: "While threads work" },
  { value: "never", label: "Never" },
];

/** This Mac's display held awake while a thread here or on a linked computer works (server/keepAwake.ts), asked of
 *  this computer; absent where it says it cannot ("this PC" on Windows). */
function KeepAwakeRow() {
  const link = registry.primary();
  const read = useHostRead(link, () => link.request<KeepAwakeStatusWire>("power.status", {}));
  const saved = useSaved();
  const [mode, setMode] = useState<KeepAwakeStatusWire["mode"] | null>(null);
  const status = read.value;
  if (status && !status.supported) return null;
  if (!status)
    return read.error ? (
      <ReadFailure computer={link.environmentId} error={read.error} retry={read.retry} />
    ) : (
      <PageRowsSkeleton rows={1} control="select" />
    );
  const vars = { mac: thisDesktopInLine() };
  return (
    <SettingRow id="general.awake" vars={vars} saved={saved} description={status.holding ? "On now" : undefined} data-keep-awake={status.holding ? "holding" : "idle"}>
      <ChoiceSelect
        label={`Keep ${vars.mac} awake`}
        value={mode ?? status.mode}
        options={KEEP_AWAKE_OPTIONS}
        onChange={(next) => {
          setMode(next);
          void saved.run(async () => read.set(await link.request<KeepAwakeStatusWire>("power.settings.set", { keepAwake: next }))).then(() => setMode(null));
        }}
      />
    </SettingRow>
  );
}

/** The inbox's Linear sign-in, kept by this window's computer and named for it, with the teams the inbox shows. */
function LinearSection() {
  const link = registry.primary();
  const computer = computerInLine(useComputerName(link.environmentId));
  const [connecting, setConnecting] = useState(false);
  const [teamsOpen, setTeamsOpen] = useState(false);
  // Undefined until the computer answers, and never made up from a failure: Connect… would otherwise show for a
  // connected account.
  const status = useHostRead(link, () => linearConnected(link.environmentId));
  const connected = status.value?.connected;
  const [error, setError] = useState<string | null>(null);
  // The teams, asked once Linear is connected: their shape while asked, one line with Retry if refused, never an
  // empty list standing in for a failure.
  const teamsRead = useHostRead(connected ? link : null, () => listLinearTeams(link.environmentId), connected ? "connected" : "");
  const teams: LinearTeam[] = teamsRead.value ?? [];
  const [hidden, setHidden] = useState(loadHiddenLinearTeamIds);

  // The dialog awaits this; a refusal stays in the dialog as its red line.
  const onConnect = async (token: string) => {
    await saveLinearToken(link.environmentId, token);
    status.set({ connected: true });
    setConnecting(false);
    clearInboxCache();
    notifyLinearChange();
  };

  const onDisconnect = async () => {
    setError(null);
    const yes = await confirmAction({
      title: `Disconnect Linear on ${computer}`,
      body: "The inbox stops showing Linear issues until you connect again.",
      action: "Disconnect",
      danger: true,
    });
    if (!yes) return;
    try {
      await disconnectLinear(link.environmentId);
      status.set({ connected: false });
      clearInboxCache();
      notifyLinearChange();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const flipTeam = (id: string, on: boolean) => {
    const next = on ? hidden.filter((team) => team !== id) : [...hidden, id];
    setHidden(next);
    saveHiddenLinearTeamIds(next);
    clearInboxCache();
  };
  const shown = teams.filter((team) => !hidden.includes(team.id)).length;

  return (
    <SettingSection of="general.linear">
      {connected === undefined ? (
        status.error ? (
          <ReadFailure computer={link.environmentId} error={status.error} retry={status.retry} />
        ) : (
          <PageRowsSkeleton rows={1} media control="button" />
        )
      ) : (
        <SettingRow
          id="general.linear"
          media={<InboxProviderMark provider="linear" className="size-4" />}
          description={connected ? `Connected on ${computer}` : undefined}
          error={error}
        >
          {connected ? (
            <Button variant="ghost" size="sm" onClick={() => void onDisconnect()}>
              Disconnect…
            </Button>
          ) : (
            <Button variant="secondary" size="sm" onClick={() => setConnecting(true)}>
              Connect…
            </Button>
          )}
        </SettingRow>
      )}
      {!connected ? null : teamsRead.value === undefined ? (
        teamsRead.error ? (
          <ReadFailure computer={link.environmentId} error={teamsRead.error} retry={teamsRead.retry} />
        ) : (
          <PageRowsSkeleton rows={1} description control="none" />
        )
      ) : teams.length > 0 ? (
        <SettingRow id="general.linearTeams" description={`${shown} of ${teams.length} shown`} onOpen={() => setTeamsOpen(true)} openLabel="Linear teams in the inbox" />
      ) : null}
      <ConnectLinearDialog open={connecting} onClose={() => setConnecting(false)} onConnect={onConnect} />
      {teamsOpen ? (
        <SwitchListDialog
          title="Linear teams in the inbox"
          items={teams.map((team) => ({ id: team.id, label: team.name, description: team.key || undefined, on: !hidden.includes(team.id) }))}
          onChange={flipTeam}
          onClose={() => setTeamsOpen(false)}
        />
      ) : null}
    </SettingSection>
  );
}

/** The key field behind Linear's Connect…: Enter or Connect checks it with the computer; a refusal stays here as the
 *  red line, success closes it. */
function ConnectLinearDialog({ open, onClose, onConnect }: { open: boolean; onClose: () => void; onConnect: (token: string) => Promise<void> }) {
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open) {
      setToken("");
      setError(null);
    }
  }, [open]);
  const submit = async () => {
    if (!token.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onConnect(token.trim());
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={(next) => (next || busy ? undefined : onClose())}>
      <ModalPanel title="Connect Linear" size="sm" busy={busy}>
        <ModalBody>
          <Field label="API key" hint="Create a personal key in Linear, under Settings, Security and access." error={error}>
            <Input
              autoFocus
              type="password"
              value={token}
              onChange={(event) => setToken(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void submit();
                }
              }}
              placeholder="lin_api_…"
              autoComplete="off"
              spellCheck={false}
            />
          </Field>
        </ModalBody>
        <DialogFooter onCancel={onClose} confirmLabel="Connect" pending={busy} disabled={!token.trim()} onConfirm={() => void submit()} />
      </ModalPanel>
    </Dialog>
  );
}
