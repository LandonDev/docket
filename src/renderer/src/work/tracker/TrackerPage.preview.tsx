import { Briefcase } from "../../chrome/icons";
import { PlaceFrame } from "../places/WorkPlacePage";
import { JOBS, NOW } from "./TrackerPage.preview.fixtures";
import { Head, HostDownLine, setWaitingOnly, TrackerBody } from "./TrackerPage";

/**
 * The tracker over five made-up jobs, for `bun run ui:preview
 * src/renderer/src/work/tracker/TrackerPage.preview.tsx#TrackerPreview --props '{"state":"all"}'`: `all`, `waiting`
 * (the Waiting on you filter on), `loading` (the bones), `silent` (a host that did not answer). The header is the
 * frame's, drawn as the frame draws it. Rendered by nothing in the app.
 */
export function TrackerPreview({ state = "all" }: { state?: "all" | "waiting" | "loading" | "silent" }) {
  setWaitingOnly(state === "waiting");
  return (
    <div className="flex h-[760px] min-w-0 flex-col bg-background">
      <PlaceFrame place="projects" label="Projects" icon={Briefcase} besideRail onClose={() => {}} head={<Head onClose={() => {}} />}>
        <TrackerBody
          jobs={JOBS}
          loading={state === "loading"}
          errors={state === "silent" ? ["The Mac did not answer."] : []}
          waitingOnly={state === "waiting"}
          now={NOW}
          onRetry={() => {}}
          // No host to ask here: the job's line as the page draws the host's words.
          Down={({ job }) => <HostDownLine words={job.down ?? ""} onRetry={() => {}} />}
        />
      </PlaceFrame>
    </div>
  );
}
