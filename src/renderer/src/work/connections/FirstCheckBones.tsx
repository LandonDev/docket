import { PageRowsSkeleton, PageSection } from "../../components/page";
import { Skeleton } from "../../components/ui/skeleton";

/**
 * Connections before its first answer, and its chunk on the way (surfaces/SettingsView.tsx): a heading's bone over
 * six rows, so the first section lands where they stood. Most rows have no press, so the bones draw none. A file of
 * its own, so the settings chunk draws them without loading the page.
 */
export function FirstCheckBones() {
  return (
    <PageSection>
      <div aria-hidden className="flex h-5 items-center">
        <Skeleton className="h-3 w-16" />
      </div>
      <div className="mt-2">
        <PageRowsSkeleton rows={6} description control="none" />
      </div>
    </PageSection>
  );
}
