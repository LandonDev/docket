import { Bones } from "../../components/bones";

/** The faint fill of a thumbnail not yet drawn: the paper's ink at a low mix, over the whole small sheet. */
export const PAPER_FAINT = "bg-[color-mix(in_srgb,var(--paper-ink)_4%,transparent)]";

/*
 * A page's sample words: nobody reads them. Their lengths give a title and three paragraphs, whose last lines end
 * short, as `PageSkeleton` (PdfCanvas.tsx) draws a page at its own size. The type is set in `cqw`, a share of the
 * sheet's width, so a sheet of any size wraps them into the same lines.
 */
export const SAMPLE_PAGE_TITLE = "Summary of the season";
export const SAMPLE_PAGE = [
  "The first part covers what was planned for the spring term and what took place instead, with the dates moved, the rooms that changed hands and the costs that came in over the budget set in the autumn.",
  "The second part sets out who led each event, how many came to it and what they said about it afterwards, so the next term can keep what worked.",
  "The last part lists what is still open, who owns each item, and when each one is due back to the office.",
];
const SAMPLE_SLIDE = { title: "Quarterly review", subtitle: "Plans for spring" };
/** A title slide's words, tall in `cqw`: the title's line (6.4 × 1.1), the gap (2.4) and the subtitle's (4 × 1.1). */
/** A slide's usual proportion, where the caller does not know its own. */
const WIDE = 16 / 9;
const SLIDE_WORDS_CQW = 6.4 * 1.1 + 2.4 + 4 * 1.1;

/**
 * The bones of a sheet of paper not yet drawn, laid over the sheet at its own size and proportion, so the picture
 * takes their place without moving: a page's title and paragraphs (a PDF's page), or a slide's title and subtitle,
 * centred as a title slide is. Drawn by Skullet from sample words on the paper's own ground (docs/agents/loading-bones.md).
 */
export function PaperBones({ shape, aspect = WIDE }: { shape: "page" | "slide"; /** A slide's width over its height. */ aspect?: number }) {
  return (
    <Bones label="" on="paper" className="absolute inset-0 @container">
      {shape === "slide" ? (
        // Centred by its top inset, worked from the sheet's proportion: Skullet measures a drawing in flow, as tall as its words.
        <div data-paper-bones="slide" className="flex w-full flex-col items-center gap-[2.4cqw] whitespace-nowrap text-(--paper-ink)" style={{ paddingTop: `${Math.max(0, (100 / aspect - SLIDE_WORDS_CQW) / 2)}cqw` }}>
          <p className="text-[6.4cqw] leading-[1.1] font-semibold">{SAMPLE_SLIDE.title}</p>
          <p className="text-[4cqw] leading-[1.1]">{SAMPLE_SLIDE.subtitle}</p>
        </div>
      ) : (
        <div data-paper-bones="page" className="flex w-full flex-col gap-[2.6cqw] px-[9%] pt-[9cqw] text-(--paper-ink)">
          <p className="self-center text-[3.3cqw] leading-[1.3] font-semibold">{SAMPLE_PAGE_TITLE}</p>
          {SAMPLE_PAGE.map((words) => (
            <p key={words} className="text-[2.6cqw] leading-[4.1cqw]">
              {words}
            </p>
          ))}
        </div>
      )}
    </Bones>
  );
}

const SAMPLE_SLIDE_LINES = ["Where the term stands", "What changes next", "Who owns each part"];

/**
 * A page's sample words at a page's own size (a 440px sheet at Fit width): a 13px title over 12px lines on an 18px
 * step, for a loading page's drawing (`PageSkeleton`, PdfCanvas.tsx; `PagedSkeleton`, formats/PagedView.tsx). `wide`
 * is a slide's: a title over three short lines.
 */
export function SamplePage({ wide = false }: { wide?: boolean }) {
  return (
    <>
      <p className="mb-1 text-[13px] leading-4 font-semibold text-foreground">{wide ? SAMPLE_SLIDE.title : SAMPLE_PAGE_TITLE}</p>
      {(wide ? SAMPLE_SLIDE_LINES : SAMPLE_PAGE).map((words) => (
        <p key={words} className="text-xs leading-[18px] text-foreground">
          {words}
        </p>
      ))}
    </>
  );
}
