import { registry } from "../../lib/connection";
import { nameInLine } from "../../lib/hostWords";
import { useLinkMay } from "../../lib/linkMay";
import { transcriberMissing } from "../../lib/workErrorWords";
import { openConnections } from "../shell/open";

/**
 * A recording its computer cannot transcribe, said in the three places it shows (a meeting's notes row, the Notes
 * dialog, the meeting canvas) as one fact through `workErrorWords`: "The transcriber is not set up on the box." The
 * way to it is Open Settings, at Connections, where that computer's tools are listed with how to install them; offered
 * only where this window manages that computer (the key Work's own switch asks), else the fact stands alone.
 */
export function useTranscriberSetUp(environmentId: string, error: unknown): (() => void) | null {
  const may = useLinkMay(environmentId, "work.set", { enabled: true });
  return may && !!error && transcriberMissing(error) ? openConnections : null;
}

/** That computer as a line names it ("the box", "this Mac"); undefined where this window does not know it. */
export function hostInLine(environmentId: string): string | undefined {
  const name = registry.environment(environmentId)?.name;
  return name ? nameInLine(name) : undefined;
}
