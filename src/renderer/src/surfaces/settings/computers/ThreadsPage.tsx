import { LOCAL_ENVIRONMENT_ID } from "../../../lib/connection";
import { useHostDevicesHosts } from "../../../lib/hostDevices";
import { useHost } from "../parts/hostRpc";
import { AgentApps } from "./AgentApps";
import { DevicesGroup, useDevicesPolling } from "./Devices";
import { ThreadsRows } from "./ThreadsRows";
import { ComputerGate } from "./read";

/**
 * Settings › Threads, "Threads on this Mac" (docs/agents/settings.md "The pages: computers"): how many threads run at
 * once here, when one is called stuck and the largest attachment; the agent apps this Mac has; and on a Mac that has
 * them, its simulators and phones. Every row asks this window's own server.
 */
export function ThreadsPage({ onOpenSession }: { onOpenSession?: (sessionId: string) => void }) {
  const host = useHost(LOCAL_ENVIRONMENT_ID);
  useDevicesPolling();
  const devices = useHostDevicesHosts()?.find((d) => d.local) ?? null;
  // One computer's page: if it does not answer, that is said once, with no section under it.
  return (
    <ComputerGate host={host}>
      <ThreadsRows host={host} rows="here" />
      <AgentApps host={host} rows="here" />
      {devices ? <DevicesGroup host={devices} onOpenSession={onOpenSession} /> : null}
    </ComputerGate>
  );
}
