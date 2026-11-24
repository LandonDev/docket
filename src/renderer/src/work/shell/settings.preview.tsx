// A preview page for `bun run ui:preview src/renderer/src/work/shell/settings.preview.tsx#WorkspacePagePreview --props '{"state":"page"}'`:
// a Work workspace's settings page, over two computers that answer from made-up settings. States: `page` (its
// sector, where it runs with computer use on each desktop and the Windows VM, its house rules, Waiting on), `failed`
// (its settings did not load: Retry), `given` (opened from a computer whose key cannot change it: one line in
// the switches' place), and `signedout` (the box signed out of LifeOS after Waiting on read its days: the sector's key
// waits on the box's sign-in, and the days' row is down, the switch kept). Rendered by nothing in the app.
import { Page } from "../../components/page";
import { setWorkOn } from "../../lib/workSwitch";
import { answerAs, asGivenComputer, JOB, Unsettled } from "../kit.preview";
import { workspaceStore } from "../../lib/tcserver/workspaces";
import { setLifeosStatus } from "./lifeos";
import { WorkWorkspacePage } from "./settings";

type State = "page" | "failed" | "given" | "signedout";

const ANSWERS: Record<string, unknown> = {
  "workspace.list": [JOB],
  "project.list": [],
  "remote.status": { environmentId: "env_box" },
  // A PC paired to the box that this window has no link to.
  "work.desktops": [{ id: "env_pc", name: "PURDUE-LT", platform: "win32" }],
  "work.winvm.state": { state: "asleep", step: null, error: null, cannot: null, sleepAfter: "30m", since: 0 },
  "work.office.filesCopyGet": { on: true },
  "work.rules.list": {
    rules: ["Sign Purdue mail as Assistant Director, Esports", "Call it the Spring LAN, never the spring tournament", "Copy Sam Ortiz on anything about scrims"].map((text, i) => ({ id: `r${i}`, workspaceId: JOB.id, text, on: true, proposalId: null, createdAt: i, updatedAt: i })),
    proposals: [],
  },
  "work.rules.voice": { on: true, count: 48, since: Date.now() - 36 * 86_400_000, from: ["dana.lee@example.edu"] },
  "work.mail.waiting": { days: 4, routine: false },
  "defaults.get": { defaults: { provider: "claude", model: "", reasoning: "high", permission: "edits" }, overridden: false },
};

let ready = false;

export function WorkspacePagePreview({ state = "page" }: { state?: State }) {
  if (!ready) {
    ready = true;
    const link = answerAs((method) => {
      if (method === "work.workspace.get") {
        if (state === "failed") throw new Error("The box did not answer");
        return { mayUseDesktop: ["env_pc"], windowsVm: true, model: null, reasoning: null, voice: false };
      }
      if (method in ANSWERS) return ANSWERS[method];
      throw new Error(`The box did not answer ${method}`);
    });
    asGivenComputer({ on: state === "given" ? ["local"] : [], computers: [{ id: "local", name: "The box", platform: "linux" }, { id: "mac", name: "MacBook Pro", platform: "darwin" }] });
    workspaceStore.reset();
    workspaceStore.attach(link);
    for (const id of ["local", "mac"]) setWorkOn(id, true);
    setLifeosStatus("local", state === "signedout" ? { lifeos: { state: "signed-out" }, keys: [{ workspaceId: JOB.id, sectors: ["purdue"], state: "waiting" }] } : { lifeos: { state: "connected", ownerId: "owner", since: 0 }, keys: [{ workspaceId: JOB.id, sectors: ["purdue"], state: "ready" }] });
  }
  return (
    <div className="w-full" style={{ maxWidth: 720 }}>
      <Page title={JOB.name}>
        <WorkWorkspacePage workspaceId={JOB.id} />
      </Page>
      <Unsettled />
    </div>
  );
}
