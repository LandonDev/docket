import type { FileAct } from "@shared/contract-work-files";
import { kindOfEntry } from "@shared/work/files";
import type { ActViewProps } from "../acts/registry";
import { KindGlyph } from "./KindGlyph";

/** A place and the folders inside it, as the act's sentence says them: "Esports Staff, General, Budgets". */
const whereWords = (where: FileAct["from"]): string => [where.name, ...where.trail].join(", ");

/**
 * A held `file.act` in the Outbox. Its sentence (the summary, every fact in
 * one line) is the detail's heading; this lists what it names: each file by
 * its kind's glyph, where it is now, and where it goes or the name it takes,
 * exactly as his press will carry it out.
 */
export function View({ item }: ActViewProps) {
  const p = item.payload as FileAct;
  const made = p.verb === "make";
  const files = made ? [p.request.name ?? "A new file"] : p.things.map((t) => t.name);
  const rows: [string, React.ReactNode][] = [
    [
      files.length > 1 ? "Files" : "File",
      <ul key="files" className="flex min-w-0 flex-col gap-1">
        {files.map((name, i) => (
          <li key={`${i}:${name}`} className="flex min-w-0 items-center gap-1.5">
            <KindGlyph kind={kindOfEntry(name).kind} tinted={false} className="size-3.5 shrink-0" />
            <span className="truncate font-medium">{name}</span>
          </li>
        ))}
      </ul>,
    ],
    [made ? "In" : "Now in", whereWords(p.from)],
    ...(p.into ? ([["Goes to", whereWords(p.into)]] as [string, string][]) : []),
    ...(p.verb === "rename" && p.request.name ? ([["New name", p.request.name]] as [string, string][]) : []),
  ];
  return (
    <dl data-slot="act-payload" className="grid grid-cols-[72px_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-[13px] leading-5">
      {rows.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="truncate text-muted-foreground">{label}</dt>
          <dd className="min-w-0 break-words text-foreground">{value}</dd>
        </div>
      ))}
    </dl>
  );
}
