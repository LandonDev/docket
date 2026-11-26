import { trimNumber } from "@server/shared/contract-macbridge";
import { PageEmpty, PageRow } from "../../../components/page";
import { LOCAL_ENVIRONMENT_ID } from "../../../lib/connection";
import { setMacBridgeLoadLimit, useMacBridgeHosts, useMacBridgeLoad } from "../../../lib/macBridge";
import { openMaySheet } from "../../../lib/settings/maySheet";
import { computerInLine, useComputerNames } from "../../../lib/settings/computerName";
import { CommitField } from "../hosts/CommitField";
import { ComputerName } from "../parts/ComputerName";
import { useHost } from "../parts/hostRpc";
import { OpenCue, SettingRow, SettingSection } from "../parts/SettingRow";
import { useSaved } from "../parts/useSaved";
import { Advanced } from "./Advanced";
import { mayHereWords, useMacBridgePolling } from "./MaySheet";
import { SignIns } from "./SignIns";

/**
 * Settings › Sharing, "Who and what may reach this Mac." (docs/agents/settings.md "The pages: computers"): who can sign
 * in to this Mac; what each linked computer may do here, a row each opening its one sheet (`openMaySheet`); and
 * Advanced, this Mac's listener, the load over which other computers' commands wait, and its ID. Every row asks this
 * window's own server.
 */
/** `advancedOpen`: the fold starts open (its picture). */
export function SharingPage({ advancedOpen = false }: { advancedOpen?: boolean } = {}) {
  const host = useHost(LOCAL_ENVIRONMENT_ID);
  useMacBridgePolling();
  return (
    <>
      <SignIns host={host} rows="sharing" />
      <OtherComputers />
      <Advanced host={host} rows="sharing" open={advancedOpen}>
        <LoadRow />
      </Advanced>
    </>
  );
}

/** One row per linked computer, by its one name, saying what it may do here. */
function OtherComputers() {
  const hosts = useMacBridgeHosts();
  const names = useComputerNames();
  return (
    <SettingSection of="sharing.may">
      {hosts.length === 0 ? <PageEmpty>No other computer is linked</PageEmpty> : null}
      {hosts.map((host) => {
        const name = names(host.environmentId, host.name);
        return (
          <PageRow
            key={host.environmentId}
            data-may={host.environmentId}
            title={<ComputerName computer={name} />}
            description={mayHereWords(host)}
            onOpen={() => openMaySheet(host.environmentId)}
            openLabel={`What ${computerInLine(name)} may do on this Mac`}
          >
            <OpenCue />
          </PageRow>
        );
      })}
    </SettingSection>
  );
}

/**
 * This Mac's load guard (docs/box.md "The load guard"): the one-minute load beside the cores, and the load over which
 * other computers' new commands and jobs wait (twice the cores until typed; an empty field follows the cores again).
 */
export function LoadRow() {
  const load = useMacBridgeLoad();
  const saved = useSaved();
  if (!load) return null;
  return (
    <SettingRow
      id="sharing.load"
      saved={saved}
      data-load={load.busy ? "holding" : "ok"}
      description={
        <>
          <span className="block tabular-nums">
            Load {load.load.toFixed(1)} on {load.cores} cores
          </span>
          {load.busy ? <span className="block text-warning">Holding new commands until under {trimNumber(load.resumeBelow)}</span> : null}
        </>
      }
    >
      <CommitField
        kind="decimal"
        aria-label="Pause other computers' commands above load"
        value={load.pinned ? load.limit : null}
        allowEmpty
        min={0.1}
        max={10_000}
        placeholder={trimNumber(load.limit)}
        onCommit={(n) => saved.run(() => setMacBridgeLoadLimit(n))}
      />
    </SettingRow>
  );
}
