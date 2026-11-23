import { EmptyState } from "../../surfaces/SurfaceSkeleton";
import type { CanvasBodyProps } from "./kind";

/** The body of an item whose kind this build does not know (a newer host made it): the one line that says what to do, where the item will be. */
export function Body(_props: CanvasBodyProps) {
  return <EmptyState title="Update TempCode to open this" />;
}
