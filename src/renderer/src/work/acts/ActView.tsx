import type { ReactNode } from "react";
import type { Chunk } from "../../lib/lazyChunk";
import { ACT_VIEWS, type ActViewProps } from "./registry";
import { GenericActView } from "./GenericActView";
import { LoadingLine } from "../../surfaces/SurfaceSkeleton";

type ViewChunk = Chunk<{ View: (props: ActViewProps) => ReactNode }>;

/** A held act's payload: its kind's own view when its pillar gave one, else the generic one. */
export function ActView(props: ActViewProps) {
  const chunk = ACT_VIEWS[props.item.kind]?.chunk as ViewChunk | null | undefined;
  if (!chunk) return <GenericActView {...props} />;
  // `surface` is cached per name in the chunk, its fallback with it: a fallback that holds no item's payload.
  const View = chunk.surface("View", <LoadingLine label="Loading the act" />);
  return <View {...props} />;
}
