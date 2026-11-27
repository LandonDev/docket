// bun run ui:preview src/renderer/src/work/pdf/PaperBones.fixtures.tsx#CanvasBonesOf --shot --fresh
// The canvas kinds' bones (docs/agents/loading-bones.md), each beside nothing but its own ground: a document item, a
// PDF's page, a page and a slide on paper not yet drawn, a paged preview, a history's compare.
import { ItemSkeleton } from "../canvas/ItemBones";
import { PagedSkeleton } from "../formats/PagedView";
import { CompareDoc, SAMPLE_COMPARE_TITLE, SAMPLE_DIFF } from "../history/Compare";
import { PaperBones } from "./PaperBones";
import { PageSkeleton } from "./PdfCanvas";

export function CanvasBonesOf({ what }: { what: "item" | "pdf" | "paper" | "paged" | "compare" }) {
  if (what === "item") return <ItemSkeleton />;
  if (what === "pdf") return <div className="flex h-[640px] flex-col"><PageSkeleton /></div>;
  if (what === "paged") return <div className="flex h-[640px] flex-col"><PagedSkeleton width={760} pages={1} /></div>;
  if (what === "compare") return <CompareDoc diff={SAMPLE_DIFF} layout="one" current={-1} title={SAMPLE_COMPARE_TITLE} />;
  return (
    <div className="flex items-start gap-6 bg-(--stage) p-6">
      <div className="relative aspect-[440/569] w-[300px] bg-(--paper)">
        <PaperBones shape="page" />
      </div>
      <div className="relative aspect-[440/569] w-[120px] bg-(--paper)">
        <PaperBones shape="page" />
      </div>
      <div className="relative aspect-video w-[320px] bg-(--paper)">
        <PaperBones shape="slide" />
      </div>
    </div>
  );
}

export default [
  { name: "a document item, waiting", props: { what: "item" } },
  { name: "a PDF, waiting", props: { what: "pdf" } },
  { name: "paper not yet drawn: two pages and a slide", props: { what: "paper" } },
  { name: "a paged preview, waiting", props: { what: "paged" } },
  { name: "the compare's sample, loaded (what its bones are measured from)", props: { what: "compare" } },
];
