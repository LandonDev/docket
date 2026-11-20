import type { HealthRow } from "@shared/work/health";
import { Page } from "../../components/page";
import { Button } from "../../components/ui/button";
import { ConnectionsView } from "./ConnectionsPage";
import type { HostView } from "./model";

/**
 * Settings → Connections, still, for `bun run ui:preview
 * src/renderer/src/work/connections/ConnectionsPage.preview.tsx#ConnectionsPreview`:
 * the page frame around the real view, as the box and the Mac might answer.
 * Rendered by nothing in the app.
 */

const NOW = Date.UTC(2026, 10, 20, 15);
const DAY = 86_400_000;
const r = (row: Omit<HealthRow, "pillar"> & { pillar?: HealthRow["pillar"] }): HealthRow => ({ pillar: "lifeos", ...row });

const BOX: HealthRow[] = [
  r({ id: "lifeos.signin", group: "LifeOS", title: "LifeOS", state: "working", line: "Signed in as Landon Hale", fix: { kind: "run", label: "Sign out", method: "work.lifeos.signOut" } }),
  r({ id: "lifeos.source:1", group: "Mail and calendar", title: "Purdue mail", state: "working", line: "Synced 3 min ago", sector: "purdue" }),
  r({ id: "lifeos.source:2", group: "Mail and calendar", title: "Cosmic calendar", state: "broken", line: "Google refused the token: sign in again in LifeOS", sector: "cosmic" }),
  r({ id: "google.client", pillar: "google", group: "Google", title: "Client id", state: "working", line: "Set" }),
  r({ id: "google.consent:hypixel", pillar: "google", group: "Google", title: "landon@hypixel.net", state: "needs-you", line: "Drive access not granted", fix: { kind: "open", label: "Grant…", url: "https://accounts.google.com/" } }),
  r({ id: "browser.running", pillar: "browser", group: "Browser", title: "The box's browser", state: "working", line: "Running, headed" }),
  r({ id: "browser.site:owa", pillar: "browser", group: "Browser", title: "Outlook on the web", state: "needs-you", line: "Not signed in. Sign in from the live browser" }),
  r({ id: "browser.vm", pillar: "browser", group: "Windows VM", title: "Windows VM", state: "working", line: "Stopped, its disk is ready", until: Date.UTC(2027, 1, 18, 4, 59) }),
  r({ id: "guests.service", pillar: "guests", group: "Work service", title: "Work service", state: "working", line: "Answering on port 7695" }),
  r({ id: "guests.tunnel", pillar: "guests", group: "Work service", title: "Hosted pages", state: "broken", line: "tempcode.landonhale.com did not answer from outside" }),
  r({ id: "formats.tools", pillar: "formats", group: "Tools", title: "Conversion tools", state: "working", line: "LibreOffice 26.8, Python 3.12, ffmpeg 9.0 and IronCalc 0.9" }),
  r({ id: "formats.tool:screen-relay", pillar: "formats", group: "Tools", title: "Screen relay", state: "working", line: "Installed" }),
];

const MAC: HealthRow[] = [
  r({ id: "lifeos.signin", group: "LifeOS", title: "LifeOS", state: "needs-you", line: "Not signed in", fix: { kind: "page", label: "Sign in…", page: "lifeos-sign-in" } }),
  r({ id: "lifeos.source:1", group: "Mail and calendar", title: "Purdue mail", state: "working", line: "Synced 3 min ago", sector: "purdue" }),
  r({ id: "formats.tools", pillar: "formats", group: "Tools", title: "Conversion tools", state: "broken", line: "LibreOffice did not install", fix: { kind: "run", label: "Install", method: "work.formats.install" } }),
  r({ id: "office.excel", pillar: "office", group: "Office", title: "Excel", state: "working", line: "Running, signed in as lhale@purdue.edu" }),
  r({ id: "office.outlook", pillar: "office", group: "Office", title: "Outlook", state: "needs-you", line: "New Outlook cannot send for a workspace. Turn it off in Outlook's menu" }),
  r({ id: "office.addin", pillar: "office", group: "Office", title: "Office add-in", state: "needs-you", line: "Sideloaded, not paired", fix: { kind: "page", label: "Pair…", page: "settings:work" } }),
  r({ id: "office.files:onedrive", pillar: "office", group: "Files", title: "OneDrive", state: "working", line: "Synced a minute ago" }),
  r({ id: "frameio.signin", pillar: "frameio", group: "Frame.io", title: "Frame.io", state: "working", line: "Signed in as Landon Hale", until: NOW + 9 * DAY }),
];

const HOSTS: Record<string, HostView[]> = {
  both: [
    { id: "box", name: "the box", status: "ready", report: { host: "env_box", at: NOW, rows: BOX } },
    { id: "mac", name: "Mac", status: "ready", report: { host: "env_mac", at: NOW, rows: MAC } },
  ],
  macOffline: [
    { id: "box", name: "the box", status: "ready", report: { host: "env_box", at: NOW, rows: BOX } },
    { id: "mac", name: "Mac", status: "offline" },
  ],
  first: [
    { id: "box", name: "the box", status: "checking" },
    { id: "mac", name: "Mac", status: "checking" },
  ],
};

export function ConnectionsPreview({ hosts = "both" }: { hosts?: keyof typeof HOSTS }) {
  const checking = HOSTS[hosts]!.some((h) => h.status === "checking");
  return (
    <Page
      title="Connections"
      description="The sign-ins and helpers Work leans on, on each host."
      actions={
        <Button variant="ghost" size="sm" disabled={checking}>
          Check again
        </Button>
      }
    >
      <ConnectionsView hosts={HOSTS[hosts]!} onRecheck={() => {}} now={NOW} />
    </Page>
  );
}
