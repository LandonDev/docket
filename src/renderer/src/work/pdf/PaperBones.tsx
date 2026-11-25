import { Skeleton } from "../../components/ui/skeleton";

/** A bone on paper: the paper is white in both themes, so the bones are its ink at a low mix, never the theme's `muted`. */
export const PAPER_BONE = "bg-[color-mix(in_srgb,var(--paper-ink)_8%,transparent)]";
/** The faint fill of a thumbnail not yet drawn: the same ink, fainter, over the whole small sheet. */
export const PAPER_FAINT = "bg-[color-mix(in_srgb,var(--paper-ink)_4%,transparent)]";

/** A page's line widths, as `PageSkeleton` (PdfCanvas.tsx) draws them: a title, then three paragraphs. */
const LINES = [92, 88, 96, 60, 0, 90, 94, 72, 0, 86, 90, 54];

/**
 * The bones of a sheet of paper not yet drawn (docs/DESIGN.md "Loading and empty states": a Skeleton in the shape of
 * what is coming), laid over the sheet at its own size and proportion, so the picture takes their place without moving:
 * a page's title and lines (a PDF's page), or a slide's title and subtitle, centred as a title slide is.
 */
export function PaperBones({ shape }: { shape: "page" | "slide" }) {
  if (shape === "slide")
    return (
      <span data-paper-bones="slide" aria-hidden className="absolute inset-0 flex flex-col items-center justify-center gap-[5%]">
        <Skeleton className={`h-[8%] w-[52%] rounded-sm ${PAPER_BONE}`} />
        <Skeleton className={`h-[5%] w-[32%] rounded-sm ${PAPER_BONE}`} />
      </span>
    );
  return (
    <span data-paper-bones="page" aria-hidden className="absolute inset-0 flex flex-col gap-[1.8%] px-[9%] pt-[7%]">
      <Skeleton className={`mb-[1.5%] h-[1.8%] w-[38%] self-center rounded-sm ${PAPER_BONE}`} />
      {LINES.map((w, i) => (w ? <Skeleton key={i} className={`h-[1.4%] rounded-sm ${PAPER_BONE}`} style={{ width: `${w}%` }} /> : <span key={i} className="h-[0.6%]" />))}
    </span>
  );
}
