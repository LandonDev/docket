import type { HealthRow } from "@shared/work/health";
import { Page } from "../../components/page";
import { Button } from "../../components/ui/button";
import { asGivenComputer } from "../kit.preview";
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
  r({ id: "lifeos.signin", group: "LifeOS", title: "LifeOS", state: "working", lifeos: "connected", line: "Signed in as Landon Hale", fix: { kind: "run", label: "Sign out", method: "work.lifeos.signOut" } }),
  r({ id: "lifeos.source:1", group: "Mail and calendar", title: "Purdue mail", state: "working", line: "Synced 3 min ago", sector: "purdue" }),
  r({ id: "lifeos.source:2", group: "Mail and calendar", title: "Cosmic calendar", state: "broken", line: "Google refused the token: sign in again in LifeOS", sector: "cosmic" }),
  r({ id: "google.client", pillar: "google", group: "Google", title: "Google Picker", state: "working", line: "Set" }),
  r({ id: "google.consent:hypixel", pillar: "google", group: "Google", title: "landon@hypixel.net", state: "needs-you", line: "Drive access not granted", fix: { kind: "open", label: "Grant…", url: "https://accounts.google.com/" } }),
  r({ id: "browser.running", pillar: "browser", group: "Browser", title: "The box's browser", state: "working", line: "Running, headed" }),
  r({ id: "browser.site:owa", pillar: "browser", group: "Browser", title: "Outlook on the web", state: "needs-you", line: "Not signed in. Sign in from the live browser" }),
  r({ id: "browser.vm", pillar: "browser", group: "Windows VM", title: "Windows VM", state: "working", line: "Stopped, its disk is ready", until: Date.UTC(2027, 1, 18, 4, 59) }),
  r({ id: "guests.service", pillar: "guests", group: "Hosting", title: "Work service", state: "working" }),
  r({ id: "guests.tunnel", pillar: "guests", group: "Hosting", title: "Hosted pages", state: "broken", line: "tempcode.landonhale.com did not answer from outside" }),
  r({ id: "formats.tools", pillar: "formats", group: "Tools", title: "Conversion tools", state: "working", line: "LibreOffice 26.8, Python 3.12, ffmpeg 9.0 and IronCalc 0.9" }),
  r({ id: "formats.tool:screen-relay", pillar: "formats", group: "Tools", title: "Screen relay", state: "working", line: "Installed" }),
];

const MAC: HealthRow[] = [
  r({ id: "lifeos.signin", group: "LifeOS", title: "LifeOS", state: "needs-you", lifeos: "signed-out", line: "Not signed in to LifeOS", fix: { kind: "page", label: "Sign in", page: "lifeos-sign-in" } }),
  r({ id: "lifeos.source:1", group: "Mail and calendar", title: "Purdue mail", state: "working", line: "Synced 3 min ago", sector: "purdue" }),
  r({ id: "formats.tools", pillar: "formats", group: "Tools", title: "Conversion tools", state: "broken", line: "LibreOffice did not install", fix: { kind: "run", label: "Install", method: "work.formats.install" } }),
  r({ id: "office.excel", pillar: "office", group: "Office", title: "Excel", state: "working", line: "Running, signed in as lhale@purdue.edu" }),
  r({ id: "office.outlook", pillar: "office", group: "Office", title: "Outlook", state: "needs-you", line: "New Outlook cannot send for a workspace. Turn it off in Outlook's menu" }),
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
  /** Neither host linked: Check again is off, and each row says why. */
  offline: [
    { id: "box", name: "the box", status: "offline" },
    { id: "mac", name: "Mac", status: "offline" },
  ],
  /** The Mac's check ran out of time: Did not answer, said once. */
  macFailed: [
    { id: "box", name: "the box", status: "ready", report: { host: "env_box", at: NOW, rows: BOX } },
    { id: "mac", name: "Mac", status: "failed", silent: true },
  ],
  /** The Mac answered with a refusal: Not checked, the refusal's own words after it. */
  macRefused: [
    { id: "box", name: "the box", status: "ready", report: { host: "env_box", at: NOW, rows: BOX } },
    { id: "mac", name: "Mac", status: "failed", silent: false, error: "Work is off on Mac. Turn it on in Settings, Work." },
  ],
  /** Seen from his laptop as a given computer: the box signed out of LifeOS (no Sign in, who can), and LifeOS silent on the Mac. */
  given: [
    { id: "box", name: "the box", status: "ready", report: { host: "env_box", at: NOW, rows: [r({ id: "lifeos.signin", group: "LifeOS", title: "LifeOS", state: "needs-you", lifeos: "signed-out", line: "Not signed in to LifeOS", fix: { kind: "page", label: "Sign in", page: "lifeos-sign-in" } })] } },
    {
      id: "mac",
      name: "Mac",
      status: "ready",
      report: {
        host: "env_mac",
        at: NOW,
        rows: [
          r({ id: "lifeos.signin", group: "LifeOS", title: "LifeOS", state: "working", lifeos: "connected", line: "Signed in", fix: { kind: "run", label: "Sign out", method: "work.lifeos.signOut" } }),
          r({ id: "lifeos.answers", group: "LifeOS", title: "LifeOS answers", state: "broken", lifeos: "unreachable", line: "LifeOS did not answer" }),
        ],
      },
    },
  ],
  /** LifeOS down on both, seen from a window that may sign each in: the box's sign-in waits, LifeOS silent on the Mac with Retry. */
  lifeosDown: [
    { id: "box", name: "the box", status: "ready", report: { host: "env_box", at: NOW, rows: [r({ id: "lifeos.signin", group: "LifeOS", title: "LifeOS", state: "needs-you", lifeos: "pairing", line: "The LifeOS sign-in waits for your approval", fix: { kind: "page", label: "Show the code", page: "lifeos-sign-in" } })] } },
    {
      id: "mac",
      name: "Mac",
      status: "ready",
      report: {
        host: "env_mac",
        at: NOW,
        rows: [
          r({ id: "lifeos.signin", group: "LifeOS", title: "LifeOS", state: "working", lifeos: "connected", line: "Signed in", fix: { kind: "run", label: "Sign out", method: "work.lifeos.signOut" } }),
          r({ id: "lifeos.answers", group: "LifeOS", title: "LifeOS answers", state: "broken", lifeos: "unreachable", line: "LifeOS did not answer" }),
        ],
      },
    },
  ],
  /**
   * The box says LifeOS has not answered it for an hour: its Retry beside Sign out. The Mac, whose LifeOS did not answer,
   * did not answer his Retry either: said once, in Hosts, its old LifeOS row gone.
   */
  unreachable: [
    { id: "box", name: "the box", status: "ready", report: { host: "env_box", at: NOW, rows: [r({ id: "lifeos.signin", group: "LifeOS", title: "LifeOS", state: "broken", lifeos: "unreachable", line: "LifeOS did not answer. Still trying since", at: NOW - 3_600_000, fix: { kind: "run", label: "Sign out", method: "work.lifeos.signOut" } }), ...BOX.slice(1)] } },
    {
      id: "mac",
      name: "Mac",
      status: "failed",
      silent: true,
      report: {
        host: "env_mac",
        at: NOW,
        rows: [
          r({ id: "lifeos.signin", group: "LifeOS", title: "LifeOS", state: "working", lifeos: "connected", line: "Signed in", fix: { kind: "run", label: "Sign out", method: "work.lifeos.signOut" } }),
          r({ id: "lifeos.answers", group: "LifeOS", title: "LifeOS answers", state: "broken", lifeos: "unreachable", line: "LifeOS did not answer" }),
        ],
      },
    },
  ],
  /** As `unreachable`, the Mac asked again by its Retry: its Hosts row stands, its Retry spinning. */
  rechecking: [
    { id: "box", name: "the box", status: "ready", report: { host: "env_box", at: NOW, rows: [r({ id: "lifeos.signin", group: "LifeOS", title: "LifeOS", state: "broken", lifeos: "unreachable", line: "LifeOS did not answer. Still trying since", at: NOW - 3_600_000, fix: { kind: "run", label: "Sign out", method: "work.lifeos.signOut" } }), ...BOX.slice(1)] } },
    {
      id: "mac",
      name: "Mac",
      status: "checking",
      silent: true,
      failed: {},
      report: {
        host: "env_mac",
        at: NOW,
        rows: [
          r({ id: "lifeos.signin", group: "LifeOS", title: "LifeOS", state: "working", lifeos: "connected", line: "Signed in", fix: { kind: "run", label: "Sign out", method: "work.lifeos.signOut" } }),
          r({ id: "lifeos.answers", group: "LifeOS", title: "LifeOS answers", state: "broken", lifeos: "unreachable", line: "LifeOS did not answer" }),
        ],
      },
    },
  ],
};

let given = false;

export function ConnectionsPreview({ hosts = "both" }: { hosts?: keyof typeof HOSTS }) {
  if (hosts === "given" && !given) {
    given = true;
    asGivenComputer({ on: ["box", "mac"], computers: [{ id: "box", name: "The box", platform: "linux" }, { id: "mac", name: "Mac", platform: "darwin" }] });
  }
  const checking = HOSTS[hosts]!.some((h) => h.status === "checking");
  const none = HOSTS[hosts]!.every((h) => h.status === "offline");
  return (
    <Page
      title="Connections"
      description="Each host's sign-ins and helpers."
      actions={
        <Button variant="ghost" size="sm" disabled={checking || none}>
          Check again
        </Button>
      }
    >
      <ConnectionsView hosts={HOSTS[hosts]!} onRecheck={() => {}} now={NOW} />
    </Page>
  );
}
