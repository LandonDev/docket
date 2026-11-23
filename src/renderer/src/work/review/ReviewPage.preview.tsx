import { weekWords } from "@shared/work/review";
import { Layers, MoreHorizontal } from "../../chrome/icons";
import { Button } from "../../components/ui/button";
import { fixtureView, WEEK, type FixtureState } from "./fixtures";
import { HeadView, NARROW_ICON } from "./Head";
import { PlaceFrame } from "../places/WorkPlacePage";
import { ReviewPageView } from "./ReviewPage";

/**
 * Review over a made-up week, for `bun run ui:preview
 * src/renderer/src/work/review/ReviewPage.preview.tsx#ReviewPreview --props '{"state":"full"}'`:
 * `full` (the Monday after, made by the routine on Friday), `sofar` (Thursday
 * afternoon), `back` (a kept week with rows dealt with since), `clear`
 * (nothing slipped), `off` (a host off), `lifeos` (LifeOS not answering),
 * `failed` (a host and two sources did not answer), `loading`; `peek` shows
 * what a press or a hover would (an Hours row open, a row's three presses, the folds open). The header is
 * the frame's, drawn here as the frame draws it. Rendered by nothing in the app.
 */
export function ReviewPreview({ state = "full", peek, gone = [] }: { state?: FixtureState; /** a still picture of what a press or a hover shows: an Hours row open, a slipped row's presses, the folds open */ peek?: { job?: string; verbs?: string; folds?: boolean }; gone?: string[] }) {
  const { view, now } = fixtureView(state);
  return (
    <div className="flex min-w-0 flex-col bg-background">
      <PlaceFrame
        place="review"
        label="Review"
        icon={Layers}
        besideRail
        onClose={() => {}}
        head={
          <HeadView
            label={weekWords(WEEK, view.tz)}
            thisWeek={state === "sofar" || state === "loading"}
            onStep={() => {}}
            onThisWeek={() => {}}
            menu={
              <Button variant="ghost" size="icon-sm" aria-label="More" className={`text-muted-foreground ${NARROW_ICON}`}>
                <MoreHorizontal />
              </Button>
            }
          />
        }
      >
        <ReviewPageView view={view} now={now} gone={new Set(gone)} canOpen={() => true} onOpen={() => {}} onPress={() => {}} onRetry={() => {}} peek={peek} />
      </PlaceFrame>
    </div>
  );
}
