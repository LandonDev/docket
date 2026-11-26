// bun run ui:preview src/renderer/src/components/ui/skeleton.fixtures.tsx#SkeletonGrounds --shot --fresh
// The bone on each ground it lies on: the page, the stage (`bg-skeleton-stage`) and the matte (`bg-skeleton-matte`).
import { Skeleton } from "./skeleton";

export function SkeletonGrounds({ ground, bone }: { ground: string; bone?: string }) {
  return (
    <div className={`grid h-28 place-items-center ${ground}`}>
      <Skeleton className={`h-16 w-48 ${bone ?? ""}`} />
    </div>
  );
}

export default [
  { name: "on the page", props: { ground: "bg-background" } },
  { name: "on stage", props: { ground: "bg-(--stage)", bone: "bg-skeleton-stage" } },
  { name: "on stage, the page's bone (before)", props: { ground: "bg-(--stage)" } },
  { name: "on matte", props: { ground: "bg-matte", bone: "bg-skeleton-matte" } },
];
