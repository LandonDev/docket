import { Tip } from "../components/tip";
import { cn } from "../lib/cn";

/**
 * A failure no row owns, said as one red 12px line in plain words
 * ("Couldn't load Linear issues"), with the program's own text, when there
 * is any, on hover alone (docs/DESIGN.md "Loading and empty states": a
 * failure is one red line; "Typography": no raw error on screen).
 */
export function FailLine({ words, detail, className }: { words: string; detail?: string | null; className?: string }) {
  const line = (
    <p role="alert" data-slot="fail-line" className={cn("text-xs text-destructive", className)}>
      {words}
    </p>
  );
  const raw = detail?.trim();
  if (!raw || raw === words) return line;
  return <Tip label={<span className="min-w-0 break-words">{raw}</span>}>{line}</Tip>;
}

/** The message of whatever a promise rejected with. */
export const rawError = (err: unknown): string => (err instanceof Error ? err.message : String(err));
