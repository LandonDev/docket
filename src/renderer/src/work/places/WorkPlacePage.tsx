import { useEffect, useRef, useState, type ReactNode } from "react";
import type { IconComponent } from "../../chrome/icons";
import { OverlayNav } from "../../chrome/TitleBar";
import { WindowControls } from "../../chrome/WindowControls";
import { usePageEscape } from "../../lib/pageEscape";
import { IS_MAC } from "../../lib/platform";
import { workPlaceLabel, workPlaceRow } from "../../lib/workPlaces";
import { SurfaceSkeleton } from "../../surfaces/SurfaceSkeleton";
import { placeChunk, type WorkPlaceModule } from "./registry";

type Props = {
  place: string;
  besideRail?: boolean;
  onClose: () => void;
  onToggleSidebar?: () => void;
};

/**
 * A page above the Work workspaces (docs/DESIGN.md "Today"): the Outbox
 * page's frame over the board, a 40px header (the place's glyph, its name,
 * what its chunk puts at the end) and the place's `View` under it. The
 * header paints with the press; the body is the place's own chunk, a column
 * of rows until it lands. Escape closes the page.
 */
export function WorkPlacePage({ place, besideRail = false, onClose, onToggleSidebar }: Props) {
  const row = workPlaceRow(place);
  const label = workPlaceLabel(place);
  const chunk = placeChunk(place);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  usePageEscape(() => onCloseRef.current(), { fields: "blur" });
  // The header's end comes from the chunk, kept in state: read from the chunk while rendering it is a constant to the
  // React Compiler, so a first render before the chunk landed would keep its null (work/shell/WorkViewPage.tsx).
  const [loaded, setLoaded] = useState<WorkPlaceModule | null>(() => chunk?.loaded() ?? null);
  useEffect(() => {
    if (loaded || !chunk) return;
    let live = true;
    void chunk.load().then(
      (module) => live && setLoaded(module),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [chunk, loaded]);
  if (!chunk) return null;
  const Head = loaded?.Head;
  const View = chunk.surface("View", <PlaceSkeleton label={label} />);
  return (
    <PlaceFrame place={place} label={label} icon={row?.icon} head={Head ? <Head onClose={onClose} /> : null} besideRail={besideRail} onClose={onClose} onToggleSidebar={onToggleSidebar}>
      <View onClose={onClose} />
    </PlaceFrame>
  );
}

/** The frame alone: the 40px header over whatever the place draws (a preview hands it a still body). */
export function PlaceFrame({
  place,
  label,
  icon: Icon,
  head,
  besideRail = false,
  onClose,
  onToggleSidebar,
  children,
}: {
  place: string;
  label: string;
  icon?: IconComponent | undefined;
  /** What the place puts at the header's end. */
  head?: ReactNode;
  besideRail?: boolean;
  onClose: () => void;
  onToggleSidebar?: (() => void) | undefined;
  children: ReactNode;
}) {
  return (
    <div role="region" aria-label={label} data-work-place={place} className="flex min-h-0 min-w-0 flex-1 flex-col text-foreground">
      <div className="flex h-10 shrink-0 select-none items-center border-b border-border" data-tauri-drag-region="deep">
        {IS_MAC && !besideRail ? <div className="w-[78px] shrink-0" /> : null}
        {besideRail ? null : <OverlayNav onBack={onClose} onToggleSidebar={onToggleSidebar} />}
        <div className="flex min-w-0 flex-1 items-center gap-2 px-3 text-[13px]">
          {Icon ? <Icon className="size-3.5 shrink-0 text-muted-foreground" /> : null}
          <span className="min-w-0 truncate font-medium">{label}</span>
        </div>
        {head ? <div className="flex shrink-0 items-center pe-3">{head}</div> : null}
        {IS_MAC ? null : <WindowControls />}
      </div>
      {children}
    </div>
  );
}

/** A place's chunk on its way: the column of rows its lists start as, under the header that is already there. */
function PlaceSkeleton({ label }: { label: string }) {
  return (
    <div className="mx-auto w-full max-w-[720px] px-6 py-6">
      <SurfaceSkeleton kind="rows" count={6} label={`Loading ${label}`} />
    </div>
  );
}
