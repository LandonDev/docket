import { Fragment, type ReactNode } from "react";
import { StatusMark, threadStateOf } from "../../../components/ui/status";
import type { SessionMeta } from "../../../lib/tcserver/types";
import type { NumberPart } from "./useFleetModel";

/**
 * The pieces a thread row is built from, shared by the fleet's agent rows
 * and detail and the master board's MasterRow: the status glyph and the
 * numbers line.
 */

/** The state's glyph alone, from the vocabulary; a settled idle is done. */
export function StatusGlyph({ status }: { status: SessionMeta["status"] }) {
  return <StatusMark state={threadStateOf(status, { settled: true })} word={false} />;
}

/** The detail's numbers as one muted line: `lead`'s glyphs first (the host
 *  glyph), 8px apart, then every fact as one comma run, "Opus 5.5 High 200k,
 *  main, +12 −3, 3 tasks, $0.12": `facts` (the model line), `lead`'s plain
 *  words (the branch), the diff in green and red, tasks, context and cost.
 *  Never two facts set apart by space alone (DESIGN "Typography and text
 *  hierarchy"). */
export function AgentNumbersLine({
  parts,
  lead = [],
  facts = [],
  className = "",
}: {
  parts: NumberPart[];
  lead?: ReactNode[];
  /** Elements that open the comma run as its first facts (the model line). */
  facts?: ReactNode[];
  className?: string;
}) {
  const shown = (t: ReactNode) => t !== null && t !== undefined && t !== false && t !== "";
  const before = lead.filter(shown);
  const words: ReactNode[] = [
    ...facts.filter(shown),
    ...before.filter(isWords),
    ...parts.map((p) =>
      p.key === "diff" ? (
        <span key={p.key}>
          <span className="text-success">+{p.adds}</span> <span className="text-destructive">−{p.dels}</span>
        </span>
      ) : (
        p.text
      ),
    ),
  ];
  if (words.length === 0 && before.length === 0) return null;
  return (
    <span
      data-slot="agent-numbers"
      className={`flex min-w-0 flex-wrap items-center gap-x-2 text-xs text-muted-foreground tabular-nums ${className}`}
    >
      {before.filter((t) => !isWords(t)).map((t, i) => (
        <Fragment key={`lead-${i}`}>{t}</Fragment>
      ))}
      {words.length > 0 ? (
        // One comma sentence; an element fact (the model line, 16px tall) sits on the run's 16px line.
        <span data-slot="agent-facts" className="min-w-0 leading-4">
          {words.map((w, i) => (
            <Fragment key={i}>
              {i > 0 ? ", " : null}
              {isWords(w) || i >= facts.filter(shown).length ? w : <span className="inline-flex max-w-full align-top">{w}</span>}
            </Fragment>
          ))}
        </span>
      ) : null}
    </span>
  );
}

const isWords = (t: ReactNode): t is string | number => typeof t === "string" || typeof t === "number";
