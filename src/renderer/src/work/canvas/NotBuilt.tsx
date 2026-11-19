import { EmptyState } from "../../surfaces/SurfaceSkeleton";
import type { CanvasBodyProps } from "./kind";

/** The body of a kind whose pillar is not built: the one line that says so, where the item will be. */
export function Body(_props: CanvasBodyProps) {
  return <EmptyState title="Not built yet" />;
}
