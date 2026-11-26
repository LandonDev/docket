// bun run ui:preview src/renderer/src/components/ui/empty-titles.preview.tsx#EmptyTitles --shot --fresh
// Empty with a short title and with one longer than its 336px measure, in a wide card, as a Work frame draws it.
import { EmptyState } from "../../surfaces/SurfaceSkeleton";

export function EmptyTitles() {
  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="flex min-h-40 rounded-lg border border-border"><EmptyState title="No chats" line="Chats you start in Work show here." /></div>
      <div className="flex min-h-40 rounded-lg border border-border"><EmptyState title="The LifeOS sign-in on the box waits for your approval" line="Sign in from a computer that manages the box" /></div>
      <div className="flex min-h-40 rounded-lg border border-border"><EmptyState title="Nothing is being driven" line="A browser or an app an agent is using shows here, live, as it works, with Take over beside it." /></div>
    </div>
  );
}
