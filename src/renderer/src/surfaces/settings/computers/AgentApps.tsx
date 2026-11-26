import { useState } from "react";
import { HarnessIcon } from "../../../chrome/HarnessIcon";
import { PageRow } from "../../../components/page";
import { BusyLabel, Button } from "../../../components/ui/button";
import { LOCAL_ENVIRONMENT_ID, WEB_ENVIRONMENT_ID, registry } from "../../../lib/connection";
import { harnessInstallCommand, probeHarnessAvailability } from "../../../lib/harness/availability";
import { refreshHarnessCatalogs } from "../../../lib/harness/registry";
import { refusalWords } from "../../../lib/settingsHome";
import { HARNESSES, HARNESS_TITLE, type HarnessId } from "../../../lib/session";
import type { Doctor, DoctorRow } from "../../../lib/tcserver/catalog";
import { CopyButton } from "../hosts/CopyButton";
import type { Host } from "../parts/hostRpc";
import { SettingSection } from "../parts/SettingRow";
import { SectionRead, useComputerRead } from "./read";

/** "2.1.263 (Claude Code)" → "2.1.263"; "codex-cli 0.162.1" → "0.162.1": the row's title already names the app. */
export function versionWords(version: string): string {
  const bare = version.replace(/\s*\([^)]*\)\s*$/, "").trim();
  return /\d/.test(bare) ? bare.replace(/^[^\d]*(?=\d)/, "") : bare;
}

/** The apps the computer knows how to update in place. */
const UPDATABLE: ReadonlySet<HarnessId> = new Set(["claude", "codex", "cursor"]);

/** This window is the computer's own: its server, or the box serving its own page. */
export const ownWindowOf = (environmentId: string): boolean =>
  environmentId === LOCAL_ENVIRONMENT_ID || environmentId === WEB_ENVIRONMENT_ID || environmentId === registry.primaryEnvironmentId;

/**
 * The agent apps one computer has (`doctor.get`, a read any key may make): each with its version; a missing one with
 * the command that installs it and Copy. Update is offered only in that computer's own window: an update elsewhere
 * would run where no one sees it go.
 */
export function AgentApps({ host, rows }: { host: Host; rows: "here" | "pc" }) {
  const doctor = useComputerRead<Doctor>(host, "doctor.get");
  const own = ownWindowOf(host.environmentId);
  return (
    <SettingSection of={`${rows}.apps`}>
      <SectionRead read={doctor} rows={HARNESSES.slice(0, 3).map(() => ({ description: true, media: true, control: "none" as const }))}>
        {(value) =>
          HARNESSES.map((harness) => (
            <AppRow
              key={harness}
              host={host}
              harness={harness}
              row={value[harness] ?? { found: false }}
              updates={own && UPDATABLE.has(harness)}
              onRow={(row) => doctor.set({ ...value, [harness]: row })}
            />
          ))
        }
      </SectionRead>
    </SettingSection>
  );
}

function AppRow({ host, harness, row, updates, onRow }: { host: Host; harness: HarnessId; row: DoctorRow; updates: boolean; onRow: (row: DoctorRow) => void }) {
  const [updating, setUpdating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const install = row.found ? undefined : harnessInstallCommand(harness);
  const update = async (): Promise<void> => {
    setUpdating(true);
    setError(null);
    try {
      onRow(await host.request<DoctorRow>("providers.update", { provider: harness }));
      // This window's picker lists the new version's models.
      void probeHarnessAvailability({ force: true });
      void refreshHarnessCatalogs([harness]);
    } catch (err) {
      setError(refusalWords(err));
    } finally {
      setUpdating(false);
    }
  };
  return (
    <PageRow
      data-agent-app={harness}
      media={<HarnessIcon harness={harness} className="size-4" />}
      title={HARNESS_TITLE[harness]}
      description={
        row.found ? (
          <>
            <span className="block tabular-nums">{row.version ? versionWords(row.version) : "Installed"}</span>
            {row.error ? <span className="block text-warning">{row.error}</span> : null}
          </>
        ) : install ? (
          <span className="block truncate font-mono">{install}</span>
        ) : (
          "Not installed"
        )
      }
      error={error ? <span className="whitespace-pre-line">{error}</span> : undefined}
    >
      {row.found && updates ? (
        <Button variant="ghost" size="sm" onClick={() => void update()} disabled={updating}>
          <BusyLabel busy={updating} label="Update" />
        </Button>
      ) : install ? (
        <CopyButton text={install} label="Copy the install command" />
      ) : null}
    </PageRow>
  );
}
