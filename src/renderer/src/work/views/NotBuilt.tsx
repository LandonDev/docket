import { EmptyState } from "../../surfaces/SurfaceSkeleton";
import type { WorkViewProps } from "./registry";

/** The body of a view whose pillar is not built: the one line that says so, where the view will be. */
export function View(_props: WorkViewProps) {
  return <EmptyState title="Not built yet" />;
}
