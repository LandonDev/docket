import { useEffect, useState } from "react";
import type { PublishStatus } from "@server/shared/contract-host";
import { PageSection } from "../../../components/page";
import { Button } from "../../../components/ui/button";
import { LOCAL_ENVIRONMENT_ID, registry } from "../../../lib/connection";
import { useHostRead } from "../../../lib/connection/hostRead";
import { confirmAction } from "../../../chrome/ConfirmDialog";
import { Spinner } from "../../../components/ui/spinner";
import { refusalWords } from "../../../lib/settingsHome";
import { SectionRead } from "./read";
import { refreshPublishStatus, startPublish, stopPublish, useHostJob, usePublishStatus, watchJob } from "../../../lib/hostJobs";
import { IS_MAC } from "../../../lib/platform";
import { isWebMode } from "../../../lib/nativeWeb";
import { tellSettingsList } from "../../../lib/settings/useListWindow";
import { CommitField } from "../hosts/CommitField";
import { PublishDialog } from "../hosts/dialogs/PublishDialog";
import { JobLog } from "./JobLog";
import { SettingRow } from "../parts/SettingRow";
import { useSaved } from "../parts/useSaved";

/** A release folder that holds a Docket checkout: the one place Publish has anything to do. */
export const publishable = (status: PublishStatus | null): boolean => !!status && status.readable && status.version !== null;

/** Kept in this app once Publish has had a checkout to build from: the page then stays in the list. */
const PUBLISH_SEEN_KEY = "docket.settings.publishSeen";
const seen = (): boolean => {
  try {
    return localStorage.getItem(PUBLISH_SEEN_KEY) === "1";
  } catch {
    return false;
  }
};

/** Whether Publish belongs in this Mac's list: its release folder holds a Docket checkout now, or did once. A folder
 *  set wrong must not take the page away, since the field that mends it is on the page. */
export function publishShown(status: PublishStatus | null, was = seen()): boolean {
  return publishable(status) || (was && status !== null);
}

/**
 * What only this Mac's server knows, told to Settings' list once Settings opens: whether its release folder holds a
 * Docket checkout (or held one), so Publish shows only where it can run (mounted by SettingsView; a Mac's desktop
 * alone).
 */
export function usePublishKnown(): void {
  const status = usePublishStatus();
  const mine = IS_MAC && !isWebMode();
  useEffect(() => {
    if (mine) void refreshPublishStatus();
  }, [mine]);
  useEffect(() => {
    if (!mine) return;
    if (publishable(status)) {
      try {
        localStorage.setItem(PUBLISH_SEEN_KEY, "1");
      } catch {
        // private mode / quota
      }
    }
    tellSettingsList({ has: { publish: publishShown(status) } });
  }, [mine, status]);
}

/** "1.0.400 from master", "last 1.0.399", and what would stop a publish. */
export function newReleaseWords(p: PublishStatus | null): string | undefined {
  if (!p) return undefined;
  if (!p.readable) return p.refusal ?? `${p.checkout} is not a Docket checkout`;
  const parts = [p.version ?? "A version not yet numbered"];
  if (p.publishedVersion) parts.push(`last published ${p.publishedVersion}`);
  if (p.branch && p.branch !== "master") parts.push("from a side branch");
  if (p.dirty) parts.push("with changes not committed");
  return parts.join(", ");
}

/**
 * Settings › Publish, "Ships a Docket release to everyone who runs it." (docs/agents/settings.md "The pages:
 * computers"): New release with Publish…, whose dialog is the confirm; the release folder it builds from; the job's
 * log. While it runs the row says so and its press is Stop…, which asks first. This Mac's own server alone.
 */
export function PublishPage() {
  const link = registry.primary();
  // The page's own read: while it is out the rows stand in their shape; a failure is one line with Retry.
  const read = useHostRead<PublishStatus>(link, () => link.request<PublishStatus>("host.publishStatus", {}));
  const status = read.value;
  const folder = useSaved();
  const [dialog, setDialog] = useState(false);
  const [stopError, setStopError] = useState<string | null>(null);
  const busy = status?.phase === "running" || status?.phase === "pending";
  const log = useHostJob(LOCAL_ENVIRONMENT_ID, "publish")?.status.phase === "running";
  const { retry } = read;
  useEffect(() => {
    const timer = window.setInterval(() => void retry(), 5_000);
    return () => window.clearInterval(timer);
  }, [retry]);
  useEffect(() => {
    if (busy) watchJob(LOCAL_ENVIRONMENT_ID, "publish");
  }, [busy]);
  const stop = async (): Promise<void> => {
    if (!(await confirmAction({ title: "Stop the publish?", body: "The release is left half made.", action: "Stop", danger: true }))) return;
    setStopError(null);
    try {
      await stopPublish();
      await retry();
    } catch (err) {
      setStopError(refusalWords(err));
    }
  };
  return (
    <PageSection>
      <SectionRead read={read} rows={[{ description: true, control: "button" }, { control: "field", wide: true }]}>
        {(value) => (
          <>
            <SettingRow
              id="publish.new"
              description={
                // Once the log is drawn below, its line says what runs; the row says it only until then.
                busy && log ? undefined : busy ? (
                  <span className="flex items-center gap-1.5">
                    <Spinner className="size-3" aria-hidden />
                    {`Publishing ${value.target ?? value.version ?? "the release"}…`}
                  </span>
                ) : (
                  newReleaseWords(value)
                )
              }
              error={stopError ?? undefined}
            >
              {busy ? (
                value.stoppable ? (
                  <Button variant="ghost" size="sm" className="text-muted-foreground hover:text-destructive" onClick={() => void stop()}>
                    Stop…
                  </Button>
                ) : null
              ) : (
                <Button variant="secondary" size="sm" disabled={!value.readable} onClick={() => setDialog(true)}>
                  Publish…
                </Button>
              )}
            </SettingRow>
            <SettingRow id="publish.folder" saved={folder} wide>
              <CommitField
                aria-label="Release folder"
                value={value.checkout}
                placeholder="~/IdeaProjects/temp-code"
                className="w-64 @max-[30rem]/page:w-full"
                onCommit={(checkout) => folder.run(async () => read.set(await link.request<PublishStatus>("host.releaseCheckout.set", { checkout })))}
              />
            </SettingRow>
            <JobLog environmentId={LOCAL_ENVIRONMENT_ID} job="publish" hostName="This Mac" />
            {dialog ? (
              <PublishDialog
                notes={value.notes}
                line={[newReleaseWords(value), value.checkout].filter(Boolean).join(", ")}
                refusal={value.refusal}
                onClose={() => setDialog(false)}
                onPublish={async (notes) => {
                  await startPublish(notes);
                  await retry();
                }}
              />
            ) : null}
          </>
        )}
      </SectionRead>
    </PageSection>
  );
}
