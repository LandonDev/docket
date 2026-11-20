import { useRef, type ReactNode } from "react";
import { Button } from "@renderer/components/ui/button";
import { reveal, FADE_IN } from "@renderer/components/ui/reveal";
import { TruncateTip } from "@renderer/components/tip";
import { Desktop } from "../chrome/icons";
import { openLightbox } from "../chrome/lightboxStore";
import { OverlayNav } from "../chrome/TitleBar";
import { WindowControls } from "../chrome/WindowControls";
import { useDocumentVisible } from "../hooks/paneVisibility";
import { cn } from "../lib/cn";
import { useComputers, type ComputerTile } from "../lib/computers";
import { previewContext } from "../lib/computerSessions";
import { usePageEscape } from "../lib/pageEscape";
import { IS_MAC } from "../lib/platform";
import { Facts } from "./settings/hosts/Facts";
import { EmptyState } from "./SurfaceSkeleton";
import { ComputerControls } from "./threads/computer/ComputerControls";
import { ENDED_WORDS, RETRY_ENDS, Viewport, ViewportLine, liveFace, sharpOf, streamSize, useLiveStream } from "./threads/computer/Viewport";

/**
 * Computers (docs/DESIGN.md "Computers"): every computer being driven now,
 * on every connected host, in one page over the thread area, like the Inbox
 * and the Outbox. A tile is the live picture and a caption under it: the
 * thread's title (a press goes to the thread), what it is doing in the
 * step's own words, and where it runs. Its controls show on hover and on
 * focus. No card, no badge, no count.
 *
 * A tile does not take the box's one display from the thread on screen: it
 * plays video where a stream is free and the 4 fps picture where it is not.
 */

/** What a tile says under its title: the step's words, or that he drives. */
export const tileLine = (tile: ComputerTile): string | null => (tile.driving ? "You are driving" : tile.doing);

const tileLabel = (tile: ComputerTile): string => {
  const app = tile.entry.row.apps[0];
  return app ? `Live view of ${app.window ? `${app.window} in ${app.name}` : app.name}` : "Live view";
};

/** A tile's picture, live: the stream while the page is seen, its own pixels at most, a click opening the full view. */
function LivePicture({ tile }: { tile: ComputerTile }) {
  const seen = useDocumentVisible();
  const measure = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLElement>(null);
  const stream = useLiveStream(tile.entry, seen, box, measure, { take: false });
  const { state } = stream;
  const over = state.status === "ended" || state.status === "failed";
  const label = tileLabel(tile);
  return (
    <div ref={measure}>
      <Viewport
        ref={box}
        face={over ? { kind: "none" } : liveFace(stream, (from) => openLightbox([{ environmentId: tile.entry.host, name: label, live: { threadId: tile.entry.row.threadId } }], 0, from))}
        label={label}
        size={streamSize(state)}
        sharp={sharpOf(state)}
        line={over ? <ViewportLine words={state.status === "ended" ? ENDED_WORDS[state.reason] : ENDED_WORDS.error} onRetry={state.status === "failed" || RETRY_ENDS.has(state.reason) ? stream.retry : undefined} /> : null}
      />
    </div>
  );
}

/** In place of a picture this desktop may not draw: one muted line, naming the machine that does. */
function ElsewherePicture({ machine }: { machine: string }) {
  return <Viewport face={{ kind: "none" }} label={`Shown on ${machine} only`} line={<ViewportLine words={`Shown on ${machine} only`} />} />;
}

export interface TileProps {
  tile: ComputerTile;
  all: readonly ComputerTile[];
  onOpenSession: (threadId: string, host: string) => void;
  /** the picture; left out where no desktop draws one (the browser /ui): the caption alone */
  picture?: ReactNode;
}

export function Tile({ tile, all, onOpenSession, picture }: TileProps) {
  const line = tileLine(tile);
  return (
    <article data-slot="computer-tile" aria-label={tile.title} className={`group/item flex min-w-0 flex-col gap-2 ${FADE_IN}`}>
      {picture}
      <div className="flex min-w-0 items-start gap-2">
        <div className="flex min-w-0 flex-1 flex-col">
          <TruncateTip text={tile.title}>
            <Button variant="link" size="xs" className="h-5 max-w-full justify-start p-0 text-[13px] leading-5 font-medium text-foreground" onClick={() => onOpenSession(tile.entry.row.threadId, tile.entry.host)}>
              <span className="truncate">{tile.title}</span>
            </Button>
          </TruncateTip>
          <Facts parts={[line && tile.driving ? <span className="text-foreground">{line}</span> : line, tile.where]} className="text-xs leading-4 text-muted-foreground" />
        </div>
        <span className={reveal("item", { row: true })}>
          <ComputerControls tile={tile} all={all} />
        </span>
      </div>
    </article>
  );
}

export interface ComputersPageProps {
  tiles: readonly ComputerTile[];
  onOpenSession: (threadId: string, host: string) => void;
  /** a tile's picture; the live one by default */
  pictureOf?: (tile: ComputerTile) => ReactNode;
}

/** The page's body, pure: the tiles one to three across by its own width, or the one empty state. */
export function ComputersPage({ tiles, onOpenSession, pictureOf }: ComputersPageProps) {
  if (tiles.length === 0) return <EmptyState title="Nothing is being driven" line="A browser or an app an agent is using shows here, live." />;
  const picture = pictureOf ?? ((tile: ComputerTile) => (tile.shownOn ? <ElsewherePicture machine={tile.shownOn} /> : <LivePicture tile={tile} />));
  return (
    <div className="@container/computers min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-none">
      {/* at least 320px a tile: one across under 704px of page, two under 1056, then three; one alone has the page, at its own pixels */}
      <div data-slot="computer-tiles" className={cn("grid grid-cols-1 gap-x-6 gap-y-8 p-4", tiles.length > 1 && "@[44rem]/computers:grid-cols-2", tiles.length > 2 && "@[66rem]/computers:grid-cols-3")}>
        {tiles.map((tile) => (
          <Tile key={tile.id} tile={tile} all={tiles} onOpenSession={onOpenSession} picture={picture(tile)} />
        ))}
      </div>
    </div>
  );
}

interface Props {
  besideRail?: boolean;
  onClose: () => void;
  onToggleSidebar: () => void;
  onOpenSession: (threadId: string, host: string) => void;
}

export function ComputersView({ besideRail = false, onClose, onToggleSidebar, onOpenSession }: Props) {
  const tiles = useComputers();
  const close = useRef(onClose);
  close.current = onClose;
  usePageEscape(() => close.current(), { fields: "blur" });
  return (
    <div role="region" aria-label="Computers" data-computers className="flex min-h-0 min-w-0 flex-1 flex-col text-foreground">
      <div className="flex h-10 shrink-0 select-none items-center border-b border-border" data-tauri-drag-region="deep">
        {IS_MAC && !besideRail ? <div className="w-[78px] shrink-0" /> : null}
        {besideRail ? null : <OverlayNav onBack={onClose} onToggleSidebar={onToggleSidebar} />}
        <div className="flex min-w-0 flex-1 items-center gap-2 px-3 text-[13px]">
          <Desktop className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 truncate font-medium">Computers</span>
        </div>
        {IS_MAC ? null : <WindowControls />}
      </div>
      <ComputersPage
        tiles={tiles}
        // the browser /ui draws no picture of any machine: the same tiles, their captions alone
        {...(previewContext().desktop ? {} : { pictureOf: () => null })}
        onOpenSession={(threadId, host) => {
          onClose();
          onOpenSession(threadId, host);
        }}
      />
    </div>
  );
}
