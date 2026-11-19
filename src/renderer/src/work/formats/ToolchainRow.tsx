import type { ToolsReport } from "@shared/contract-work-formats";
import { PageRow, PageRowsSkeleton } from "../../components/page";
import { Button } from "../../components/ui/button";
import { formatBytes } from "../../lib/attachmentUpload";
import type { Link } from "../../lib/connection/link";
import { useHostRead } from "../../lib/connection/hostRead";

/**
 * Settings → Work, "Where it runs": one row saying which conversion tools
 * this host has (docs/agents/work-formats.md, "The toolchain"). The page
 * (milestone 8) mounts it with the host's link; it reads
 * `work.formats.tools` once.
 */

/** The toolchain's own tools by their proper names; a pillar's tool shows by its manifest name. The venv is Python's, never a tool of its own here. */
const NAMES: Record<string, string> = { libreoffice: "LibreOffice", python: "Python", ffmpeg: "ffmpeg", ironcalc: "IronCalc" };
const HIDDEN = new Set(["venv"]);

/** major.minor: the line names a release, not a build. */
const short = (version: string): string => version.split(".").slice(0, 2).join(".");

export interface ToolchainLine {
  /** "LibreOffice 26.8, Python 3.12, ffmpeg 9.0 and IronCalc 0.9", or "None installed" */
  installed: string;
  /** the tools that did not install here, by name; a tool the manifests do not offer on this platform is not one */
  failed: string | null;
  bytes: number;
}

export function toolchainLine(report: Pick<ToolsReport, "tools">): ToolchainLine {
  const shown = report.tools.filter((t) => !HIDDEN.has(t.name));
  const ok = shown.filter((t) => t.ok);
  const failed = shown.filter((t) => !t.ok && !t.error?.startsWith("not offered"));
  const names = ok.map((t) => `${NAMES[t.name] ?? t.name} ${short(t.version)}`);
  return {
    installed: names.length ? listOf(names) : "None installed",
    failed: failed.length ? `${listOf(failed.map((t) => NAMES[t.name] ?? t.name))} did not install` : null,
    bytes: report.tools.filter((t) => t.ok).reduce((n, t) => n + (t.bytes ?? 0), 0),
  };
}

function listOf(names: string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

export function ToolchainRow({ link }: { link: Link | null | undefined }) {
  const read = useHostRead(link, () => link!.request<ToolsReport>("work.formats.tools", {}));
  return <ToolchainRowView report={read.value} error={read.error} onRetry={read.retry} />;
}

/** The row as the host's answer leaves it: its shape while loading, the refusal with Retry, or the line. */
export function ToolchainRowView({ report, error, onRetry }: { report: Pick<ToolsReport, "tools"> | undefined; error: string | null; onRetry: () => void }) {
  if (!report) {
    if (!error) return <PageRowsSkeleton rows={1} description control="none" />;
    return (
      <PageRow title="Conversion tools" error={error}>
        <Button variant="ghost" size="sm" onClick={onRetry}>
          Retry
        </Button>
      </PageRow>
    );
  }
  const line = toolchainLine(report);
  return (
    <PageRow title="Conversion tools" description={line.installed} error={line.failed ?? undefined}>
      {line.bytes > 0 ? <span className="text-xs tabular-nums text-muted-foreground">{formatBytes(line.bytes)}</span> : null}
    </PageRow>
  );
}
