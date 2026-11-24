// A preview frame for `bun run ui:preview src/renderer/src/surfaces/TranscriptPane.preview.tsx#TranscriptPanePreview --width 1320`:
// the transcript pane at one width with the message list open or folded, the list and the column placed
// with AgentTranscript's own classes and the model's rules, so the fold's place shows at each width.
import type { Block } from "../lib/session";
import { TranscriptOutline } from "./TranscriptOutline";
import { COLUMN_MAX_CLASS, LIST_SPACE, columnBeside, outlinePlacement } from "./transcriptOutlineModel";
import { messageListChunk } from "./chunks";

messageListChunk.preload();

const NOW = new Date(2026, 10, 1, 18, 0).getTime();
const at = (h: number, m: number) => new Date(2026, 10, 1, h, m).getTime();
const asks = [
  "Why does the rail flicker when a thread settles?",
  "Try it with the panel closed",
  "Make the left side a list of my messages",
  "Ship it",
];
const turns: Block[][] = asks.map((text, i) => [
  { id: `u${i}`, role: "user", text, startedAt: at(9 + i * 2, 4) },
  { id: `a${i}`, role: "assistant", text: "Done." },
]);
const answer =
  "The rail paints from the launch mirror, then reconciles with the host's changes. A thread that settles sends its summary twice, once from the turn's end and once from the mirror's write, and the second paint lands a frame later with the same row, so the row's height is measured twice and the rail moves by a pixel.";

export function TranscriptPanePreview({ width, folded }: { width: number; folded: boolean }) {
  const placement = outlinePlacement(width, asks.length);
  const beside = columnBeside(placement, folded);
  return (
    <div className="relative overflow-hidden rounded-lg border border-border font-sans text-[13px] leading-5" style={{ width }}>
      {placement !== "hidden" ? (
        <div className="sticky top-0 z-10 h-0">
          <TranscriptOutline
            className="absolute top-4 left-4 w-52 font-sans"
            turns={turns}
            readerTurn={2}
            onJump={() => {}}
            now={NOW}
            locale="en-US"
            folded={folded}
          />
        </div>
      ) : null}
      <div className="px-4 pt-4 pb-4" style={beside ? { paddingLeft: LIST_SPACE } : undefined}>
        <div className={`${beside ? "mr-auto" : "mx-auto"} flex w-full min-w-0 flex-col gap-3 ${COLUMN_MAX_CLASS}`}>
          <div className="ml-auto max-w-[80%] rounded-lg bg-muted px-3 py-2">{asks[2]}</div>
          <div>{answer}</div>
          <div>{answer}</div>
        </div>
      </div>
    </div>
  );
}
