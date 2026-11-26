import { useCallback, useEffect, useState, type ReactNode } from "react";
import {
  deleteSimulatorConfirm,
  devicesSummary,
  type HostDevicesHost,
  type HostDevicesReport,
  type Phone,
  type Simulator,
} from "@server/shared/contract-hostdevices";
import { PageEmpty, PageError, PageRowsSkeleton } from "../../../components/page";
import { Button } from "../../../components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../../../components/ui/dropdown-menu";
import { MoreHorizontal } from "../../../chrome/icons";
import { ConfirmDialog, errorText } from "../../../chrome/ConfirmDialog";
import { deleteSimulator, openXcodeDevices, refreshHostDevicesHosts, shutdownSimulator, useHostDevices } from "../../../lib/hostDevices";
import { isWebMode } from "../../../lib/nativeWeb";
import { settingTitle } from "../../../lib/settings/map";
import { Facts, splitFacts } from "../hosts/Facts";
import { Group, Row } from "../hosts/Group";

/**
 * The devices a Mac is running (docs/box.md "Devices on the Mac"), in that
 * Mac's section: the summary at the heading's end, one row per simulator and
 * iPhone with its state, the thread that holds it, and on hover or focus its
 * actions (Shutdown, Delete behind a confirm that names the holder; Open in
 * Xcode for an iPhone). The report is read every 30 s only while the group
 * is on screen; the list of Macs every 15 s while the page is.
 */

export function useDevicesPolling(): void {
  useEffect(() => {
    void refreshHostDevicesHosts().catch(() => {});
    const t = window.setInterval(() => void refreshHostDevicesHosts().catch(() => {}), 15_000);
    return () => window.clearInterval(t);
  }, []);
}

export function DevicesGroup({ host, onOpenSession }: { host: HostDevicesHost; onOpenSession?: (sessionId: string) => void }) {
  const { report, error } = useHostDevices(host.environmentId);
  const id = host.environmentId;
  return (
    <DevicesBlock
      host={host}
      report={report}
      error={error}
      onOpenSession={onOpenSession}
      onShutdown={(udid) => shutdownSimulator(id, udid)}
      onDelete={(udid) => deleteSimulator(id, udid)}
      onOpenXcode={() => openXcodeDevices(id)}
      loadElsewhere={host.local && !isWebMode()}
    />
  );
}

export interface DevicesBlockProps {
  host: HostDevicesHost;
  report: HostDevicesReport | null;
  error: string | null;
  onOpenSession?: (sessionId: string) => void;
  onShutdown: (udid: string) => Promise<unknown>;
  onDelete: (udid: string) => Promise<unknown>;
  onOpenXcode: () => Promise<unknown>;
  /** The page shows this Mac's load in Sharing's Pause other computers' commands above load (the desktop's own Mac); else the heading keeps it. */
  loadElsewhere?: boolean;
}

/** The group itself, with everything it shows passed in (the dom test renders this). */
export function DevicesBlock({ host, report, error, onOpenSession, onShutdown, onDelete, onOpenXcode, loadElsewhere = false }: DevicesBlockProps) {
  const [busy, setBusy] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<Simulator | null>(null);
  const run = useCallback(async (key: string, work: () => Promise<unknown>) => {
    setBusy(key);
    setFailed(null);
    try {
      await work();
    } catch (err) {
      setFailed(errorText(err));
    } finally {
      setBusy(null);
    }
  }, []);

  // The heading says what the rows cannot: the Xcode in use, and the load when the page has no Load limit row
  // for this Mac. Each simulator and phone, with its state, is a row of its own, so the heading names none.
  const summaryParts = report
    ? [
        ...splitFacts(devicesSummary(report)).filter((part) => part.startsWith("load ") && !loadElsewhere),
        ...(report.xcode ? [`${report.xcode.name}${report.xcode.version ? ` ${report.xcode.version}` : ""}`] : []),
        ...(report.xcode?.from === "developerDir" ? ["DEVELOPER_DIR"] : []),
        ...report.problems,
      ]
    : [];
  const summary = report ? (
    <Facts parts={summaryParts} className="justify-end text-xs text-muted-foreground" />
  ) : error ? (
    <span className="text-xs text-muted-foreground">Not reachable</span>
  ) : null;

  return (
    <Group title={host.local ? settingTitle("here.devices") : `${settingTitle("here.devices")} on ${host.name}`} data-setting={host.local ? "here.devices" : undefined} data-devices={host.environmentId} action={<span data-summary className="min-w-0">{summary}</span>}>
      {!report && !error ? (
        <div data-looking>
          <PageRowsSkeleton rows={2} description control="none" />
        </div>
      ) : null}
      {error && !report ? <PageError>{error}</PageError> : null}
      {report ? (
        <>
          {report.simulators.length === 0 ? (
            <PageEmpty data-empty>No simulators</PageEmpty>
          ) : null}
          {report.simulators.map((sim) => (
            <DeviceRow
              key={sim.udid}
              udid={sim.udid}
              name={sim.name}
              detail={[sim.runtime]}
              state={simulatorState(sim)}
              holder={sim.holder}
              onOpenSession={onOpenSession}
              busy={busy === sim.udid}
            >
              {/* Two acts, one control: a ⋯ menu, always in view. */}
              <DropdownMenu>
                <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label={`${sim.name} actions`} disabled={busy !== null} className="text-muted-foreground" />}>
                  <MoreHorizontal />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {sim.state === "booted" ? <DropdownMenuItem onClick={() => void run(sim.udid, () => onShutdown(sim.udid))}>Shut down</DropdownMenuItem> : null}
                  <DropdownMenuItem variant="destructive" onClick={() => setConfirm(sim)}>
                    Delete…
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </DeviceRow>
          ))}
          {report.phones.map((phone) => (
            <DeviceRow
              key={phone.udid}
              udid={phone.udid}
              name={phone.name}
              // The model only when the owner's name for it says something else.
              detail={phone.model && phone.model !== phone.name ? [phone.model, phone.os] : [phone.os]}
              state={phoneState(phone)}
              holder={phone.holder}
              onOpenSession={onOpenSession}
              busy={busy === "xcode"}
            >
              <Button variant="ghost" size="sm" disabled={busy !== null} onClick={() => void run("xcode", onOpenXcode)}>
                Open in Xcode
              </Button>
            </DeviceRow>
          ))}
        </>
      ) : null}
      {failed ? <PageError>{failed}</PageError> : null}
      {confirm ? (
        <ConfirmDialog
          {...deleteSimulatorConfirm(confirm)}
          confirmLabel="Delete"
          danger
          onCancel={() => setConfirm(null)}
          // The delete runs inside the confirm: a refusal is its red line and it stays.
          onConfirm={async () => {
            setBusy(confirm.udid);
            setFailed(null);
            try {
              await onDelete(confirm.udid);
            } finally {
              setBusy(null);
            }
          }}
          onDone={() => setConfirm(null)}
        />
      ) : null}
    </Group>
  );
}

/** Who holds a device, in a line under it: the thread by its title. */
export const holderWords = (holder: NonNullable<Simulator["holder"]>): string => `In use by “${holder.title}”`;

/** "Booted", "34% CPU"; "Shut down"; the simulator's own word while it changes. */
export const simulatorState = (sim: Simulator): string[] => {
  if (sim.state === "booted") return sim.cpu !== undefined ? ["Booted", `${Math.round(sim.cpu)}% CPU`] : ["Booted"];
  if (sim.state === "shutdown") return ["Shut down"];
  return [sim.stateText ?? "Changing"];
};

/** "Connected", "USB"; "Paired"; "Unavailable". */
export const phoneState = (phone: Phone): string[] => {
  if (phone.connection === "connected") return phone.transport ? ["Connected", phone.transport] : ["Connected"];
  if (phone.connection === "paired") return ["Paired"];
  return ["Unavailable"];
};

function DeviceRow({
  udid,
  name,
  detail,
  state,
  holder,
  onOpenSession,
  busy,
  children,
}: {
  udid: string;
  name: string;
  detail: readonly string[];
  state: string[];
  holder: Simulator["holder"];
  onOpenSession?: (sessionId: string) => void;
  busy: boolean;
  children: ReactNode;
}) {
  return (
    <Row
      title={name}
      data-device={udid}
      description={
        <>
          <span className="block">
            <Facts parts={[...detail, ...state]} />
          </span>
          {holder ? (
            onOpenSession ? (
              // The 16px link reaches 24px; its words truncate inside it, so nothing clips the hit area.
              <span data-holder className="flex min-w-0">
                <Button
                  variant="link"
                  size="xs"
                  className="h-auto max-w-full min-w-0 shrink px-0 text-xs font-normal text-muted-foreground hover:text-foreground after:absolute after:inset-x-0 after:-inset-y-1 after:content-['']"
                  onClick={() => onOpenSession(holder.sessionId)}
                >
                  <span className="min-w-0 truncate">{holderWords(holder)}</span>
                </Button>
              </span>
            ) : (
              <span data-holder className="block truncate">
                {holderWords(holder)}
              </span>
            )
          ) : null}
        </>
      }
    >
      <span data-device-actions data-busy={busy ? "" : undefined} className="flex items-center gap-1">
        {children}
      </span>
    </Row>
  );
}
