import { useEffect, useState } from "react";
import type { PublishStatus } from "@server/shared/contract-host";
import { PageSection } from "../../../components/page";
import { Button } from "../../../components/ui/button";
import { LOCAL_ENVIRONMENT_ID } from "../../../lib/connection";
import { refreshPublishStatus, setReleaseCheckout, startPublish, usePublishStatus, watchJob } from "../../../lib/hostJobs";
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
  const parts = [`${p.version ?? "HEAD"} from ${p.branch ?? "HEAD"}`];
  if (p.publishedVersion) parts.push(`last ${p.publishedVersion}`);
  if (p.dirty) parts.push("with changes not committed");
  return parts.join(", ");
}

/**
 * Settings › Publish, "Ships a Docket release to everyone who runs it." (docs/agents/settings.md "The pages:
 * computers"): New release with Publish…, whose dialog is the confirm; the release folder it builds from; the job's
 * log, whose Stop… asks first. This Mac's own server alone.
 */
export function PublishPage() {
  const status = usePublishStatus();
  const folder = useSaved();
  const [dialog, setDialog] = useState(false);
  const busy = status?.phase === "running" || status?.phase === "pending";
  useEffect(() => {
    void refreshPublishStatus();
    const timer = window.setInterval(() => void refreshPublishStatus(), 5_000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    if (busy) watchJob(LOCAL_ENVIRONMENT_ID, "publish");
  }, [busy]);
  return (
    <PageSection>
      <SettingRow id="publish.new" description={newReleaseWords(status)}>
        <Button variant="secondary" size="sm" disabled={!status || !status.readable || busy} onClick={() => setDialog(true)}>
          Publish…
        </Button>
      </SettingRow>
      <SettingRow id="publish.folder" saved={folder} wide>
        <CommitField
          aria-label="Release folder"
          value={status?.checkout ?? ""}
          placeholder="~/IdeaProjects/temp-code"
          className="w-64 @max-[30rem]/page:w-full"
          onCommit={(checkout) => folder.run(() => setReleaseCheckout(checkout))}
        />
      </SettingRow>
      <JobLog environmentId={LOCAL_ENVIRONMENT_ID} job="publish" hostName="This Mac" />
      {dialog && status ? (
        <PublishDialog notes={status.notes} line={[newReleaseWords(status), status.checkout].filter(Boolean).join(", ")} refusal={status.refusal} onClose={() => setDialog(false)} onPublish={startPublish} />
      ) : null}
    </PageSection>
  );
}
