// A preview page for `bun run ui:preview src/renderer/src/surfaces/settings/Work.preview.tsx#WorkSettingsPreview --props '{"state":"on"}'`:
// Settings → Work, as the page draws it, over two computers that answer from made-up settings. States: `off` (the
// switch alone), `on` (the switch and Work's sections: the digest, models, where it runs, the Windows VM, guest links,
// Mail with LifeOS signed out), and `elsewhere` (on, from a computer whose key cannot switch the box: the switch says so and the
// box's controls are gone), and `nowhere` (on, from a key that may switch no host, a phone's or /ui: no switch, the line
// says where). Rendered by nothing in the app.
import { Page } from "../../components/page";
import { setWorkOn } from "../../lib/workSwitch";
import { seedDigestHost } from "../../work/digest/store";
import { setLifeosStatus } from "../../work/shell/lifeos";
import { answerAs, asGivenComputer, JOB, Unsettled } from "../../work/kit.preview";
import { workDigestChunk, workShellChunk } from "../chunks";
import { WorkPage } from "./Work";

type State = "off" | "on" | "elsewhere" | "nowhere";

const NOW = Date.now();
// What each host says, by method; a method it does not know is refused, which the page draws as that section's error.
const ANSWERS: Record<string, unknown> = {
  "workspace.list": [JOB],
  "project.list": [],
  "work.lifeos.sectors": { sectors: [{ key: "purdue", label: "Purdue", order: 1 }, { key: "cosmic", label: "Cosmic", order: 2 }, { key: "life", label: "Life", order: 6 }] },
  "work.winvm.state": { state: "asleep", step: null, error: null, cannot: null, sleepAfter: "30m", since: NOW - 3_600_000 },
  "work.winvm.points": { points: [{ id: "p1", name: "Before setup", at: NOW - 9 * 86_400_000, by: "keeper" }] },
  "work.guests.list": [],
  "work.office.filesLibraries": {
    libraries: [
      { id: "local~1", host: "local", path: "/cloud/Esports Staff/Events", team: "Esports Staff", library: "Events", tenant: "Purdue University", kind: "channels" },
      { id: "local~2", host: "local", path: "/cloud/mine", team: "My OneDrive", library: null, tenant: "Purdue University", kind: "mine" },
    ],
    roots: [],
    off: [],
  },
  "work.office.filesCopyGet": { on: true },
  "work.files.startPlaces": { places: [] },
};

// Work's sections are a chunk of their own: landed before the first render, as the page draws them once they have.
await Promise.all([workShellChunk.load(), workDigestChunk.load(), import("../../work/mail/MailSettingsSection")]);

let ready = false;

export function WorkSettingsPreview({ state = "on" }: { state?: State }) {
  if (!ready) {
    ready = true;
    answerAs((method, _params, env) => {
      // The Windows VM lives on the box alone.
      if (method === "work.winvm.state" && env !== "local") return { state: "none", step: null, error: null, cannot: null, sleepAfter: "30m", since: 0 };
      if (method in ANSWERS) return ANSWERS[method];
      throw new Error(`The box did not answer ${method}`);
    });
    // Two computers: this one, and the box; a given key on the box where it cannot switch Work there.
    asGivenComputer({ on: state === "elsewhere" ? ["local"] : state === "nowhere" ? ["local", "mac"] : [], computers: [{ id: "local", name: "The box", platform: "linux" }, { id: "mac", name: "MacBook Pro", platform: "darwin" }] });
    if (state !== "off") for (const id of ["local", "mac"]) setWorkOn(id, true);
    // LifeOS is signed out on the box (Connections holds the sign-in): Mail's section says so in one line, and the
    // sectors LifeOS has are not listed. A signed-in LifeOS would open a session a static page cannot.
    setLifeosStatus("local", { lifeos: { state: "signed-out" }, keys: [] });
    for (const id of ["local", "mac"]) seedDigestHost(id, { settings: { at: "07:30", zone: "America/Chicago", levels: {}, nextAt: NOW + 20 * 3_600_000 } });
  }
  return (
    <div className="w-full" style={{ maxWidth: 720 }}>
      <Page title="Work">
        <WorkPage />
      </Page>
      <Unsettled />
    </div>
  );
}
