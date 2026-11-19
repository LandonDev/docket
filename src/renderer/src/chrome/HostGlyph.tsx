import { useEnvironments } from "../lib/connection/status";
import { hostKind, useHostPlatform, type HostKind } from "../lib/hostPlatform";
import { Tip } from "../components/tip";
import { CloudServer, Desktop, Laptop } from "./icons";

const ICON: Record<HostKind, typeof Laptop> = { mac: Laptop, pc: Desktop, server: CloudServer };

/**
 * Which host a thread or agent lives on: a laptop for a Mac, a desktop for a
 * Windows PC, a server for anything else, 12 px and muted, the host's name on hover. Drawn only when
 * the window knows two or more hosts; with one there is nothing to tell
 * apart. Monochrome on purpose: colour on a row is for status dots. `bare`
 * drops its own tooltip, for a glyph inside a control whose tooltip names
 * the host (a header chip).
 */
export function HostGlyph({
  environmentId,
  title,
  bare = false,
  className = "",
}: {
  environmentId: string | null | undefined;
  /** Replaces the host's name on hover (a row that says its host is offline). */
  title?: string;
  bare?: boolean;
  className?: string;
}) {
  // One glyph per row, in the first paint: out of the compiler's memo output, which outweighed it.
  "use no memo";
  const environments = useEnvironments();
  const platform = useHostPlatform(environmentId ?? undefined);
  if (!environmentId || environments.length < 2) return null;
  const name = environments.find((e) => e.id === environmentId)?.name ?? environmentId;
  const kind = hostKind(platform);
  const Icon = ICON[kind];
  const label = title ?? name;
  const glyph = (
    <span
      role="img"
      aria-label={label}
      data-host-glyph={environmentId}
      data-host-kind={kind}
      className={`inline-flex shrink-0 text-muted-foreground ${className}`}
    >
      <Icon className="size-3" aria-hidden />
    </span>
  );
  return bare ? glyph : <Tip label={label}>{glyph}</Tip>;
}
