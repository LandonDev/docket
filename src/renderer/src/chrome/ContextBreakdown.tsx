import { COMPACTING_WORDS } from "@shared/statusWords";
import { Button } from "../components/ui/button";
import { Skeleton } from "../components/ui/skeleton";
import { Spinner } from "../components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "../components/ui/tooltip";
import { cn } from "../lib/cn";
import type { ContextReading } from "../lib/contextCache";
import { formatTokens, type ContextUsage } from "../lib/contextUsage";

const LIST_ROWS = 6;

/**
 * The popover's body: the head line, what compaction is doing, the
 * harness's categories largest first, each list (memory files, MCP tools)
 * under the category it details so no total is said twice, and Compact.
 * The live total heads it; the breakdown is the last settled reading, a
 * skeleton until the first one lands, and one line mid-turn when there is
 * none yet.
 */
export function ContextBreakdown({
  reading,
  usage,
  busy = false,
  compacting = false,
  onCompact,
}: {
  reading: ContextReading | null;
  usage?: ContextUsage;
  busy?: boolean;
  compacting?: boolean;
  /** Absent: the thread cannot compact now, and the foot is not drawn. */
  onCompact?: () => void;
}) {
  const total = usage?.used ?? reading?.totalTokens ?? 0;
  const max = usage?.window ?? reading?.maxTokens ?? 0;
  const categories = (reading?.categories ?? []).filter((c) => c.tokens > 0).sort((a, b) => b.tokens - a.tokens);
  const lists = reading ? breakdownLists(reading) : [];
  const listOf = (name: string) => lists.find((l) => l.title.toLowerCase() === name.trim().toLowerCase());
  // A list whose category the harness did not send stands on its own after them.
  const loose = lists.filter((l) => !categories.some((c) => listOf(c.name) === l));
  return (
    <div className="flex flex-col gap-4" data-context-breakdown>
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-[13px] font-medium text-foreground">Context</span>
        <span className="text-xs tabular-nums text-muted-foreground">
          {max ? `${formatTokens(total)} of ${formatTokens(max)}` : formatTokens(total)}
        </span>
      </div>
      {compacting ? (
        <div className="-mt-2 flex items-center gap-2 text-[13px] text-muted-foreground">
          <Spinner className="size-3.5" aria-hidden />
          {COMPACTING_WORDS}
        </div>
      ) : null}
      {!reading ? (
        busy ? (
          <p className="text-xs text-muted-foreground">Breakdown after this turn</p>
        ) : (
          <div className="flex flex-col gap-2" aria-busy data-context-loading>
            {["w-2/3", "w-1/2", "w-3/5"].map((width) => (
              <div key={width} className="flex h-4 items-center justify-between gap-3">
                <Skeleton className={cn("h-3", width)} />
                <Skeleton className="h-3 w-8" />
              </div>
            ))}
          </div>
        )
      ) : categories.length > 0 ? (
        <div className="flex flex-col" data-context-categories>
          {categories.map((c) => {
            const list = listOf(c.name);
            return (
              <div key={c.name} data-context-category={c.name}>
                <div className="flex h-6 items-center justify-between gap-3 text-[13px]">
                  <span className="min-w-0 truncate text-muted-foreground">{c.name}</span>
                  <span className="shrink-0 tabular-nums text-foreground">{formatTokens(c.tokens)}</span>
                </div>
                {list ? <ListRows list={list} /> : null}
              </div>
            );
          })}
        </div>
      ) : null}
      {loose.map((list) => (
        <div key={list.title} className="flex flex-col" data-context-list={list.title}>
          <div className="mb-1 flex items-baseline justify-between gap-3 text-xs text-muted-foreground">
            <span className="font-medium">{list.title}</span>
            <span className="tabular-nums">{formatTokens(list.rows.reduce((n, r) => n + r.tokens, 0))}</span>
          </div>
          <ListRows list={list} />
        </div>
      ))}
      {onCompact ? (
        <div className="-mb-1 -me-2.5 flex justify-end">
          <Button variant="ghost" size="sm" onClick={onCompact} className="font-normal">
            Compact
          </Button>
        </div>
      ) : null}
    </div>
  );
}

type BreakdownListData = { title: string; rows: { key: string; label: string; tokens: number; tip?: string; sans?: boolean }[] };

/** The reading's two lists, by the names the harness gives their categories. */
function breakdownLists(reading: ContextReading): BreakdownListData[] {
  const lists: BreakdownListData[] = [
    {
      title: "Memory files",
      rows: (reading.memoryFiles ?? []).map((m) => ({ key: m.path, label: memoryLabel(m.path), tokens: m.tokens, tip: m.path, sans: true })),
    },
    {
      title: "MCP tools",
      rows: (reading.mcpTools ?? []).map((t) => ({
        key: `${t.server}/${t.name}`,
        label: t.server ? `${t.server}/${mcpToolName(t.name, t.server)}` : t.name,
        tokens: t.tokens,
      })),
    },
  ];
  return lists.filter((l) => l.rows.length > 0);
}

/** A list's rows, one step in: at most six, largest first, then "+N more". */
function ListRows({ list }: { list: BreakdownListData }) {
  const sorted = [...list.rows].sort((a, b) => b.tokens - a.tokens);
  const shown = sorted.slice(0, LIST_ROWS);
  return (
    <div className="flex flex-col ps-3" data-context-rows={list.title}>
      {shown.map((r) => {
        const row = (
          <div key={r.key} className="flex h-6 items-center justify-between gap-3 text-xs">
            <span className={cn("min-w-0 truncate text-muted-foreground", !r.sans && "font-mono")}>{r.label}</span>
            <span className="shrink-0 tabular-nums text-muted-foreground">{formatTokens(r.tokens)}</span>
          </div>
        );
        // A memory file's path is its tooltip alone, never its words.
        return r.tip ? (
          <Tooltip key={r.key}>
            <TooltipTrigger render={row} />
            <TooltipContent side="left">{r.tip}</TooltipContent>
          </Tooltip>
        ) : (
          row
        );
      })}
      {sorted.length > shown.length ? (
        <div className="flex h-6 items-center text-xs text-muted-foreground">+{sorted.length - shown.length} more</div>
      ) : null}
    </div>
  );
}

/** `mcp__server__tool` reads as `tool` beside its server. */
function mcpToolName(name: string, server: string): string {
  const prefix = `mcp__${server}__`;
  return name.startsWith(prefix) ? name.slice(prefix.length) : name;
}

/** A memory file by its name and where it applies, never its path: "CLAUDE.md, user" for one under a
 *  CLI's home folder (~/.claude), else "CLAUDE.md, docs", the folder it sits in. */
export function memoryLabel(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  const file = parts.at(-1) ?? path;
  if (parts.slice(0, -1).some((part) => /^\.(claude|codex|cursor|config)$/.test(part))) return `${file}, user`;
  const folder = parts.at(-2);
  return folder ? `${file}, ${folder}` : file;
}
