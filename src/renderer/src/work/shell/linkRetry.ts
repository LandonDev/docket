import { registry } from "../../lib/connection";

const TRYING = new Set(["connecting", "reconnecting"]);

/**
 * Retry on "<host> is not connected": asks the link to try now (`registry.retry`) and settles once it has answered,
 * open or not, so the line that was pressed keeps its place with Retry spinning until then (docs/DESIGN.md "Loading
 * and empty states"), never the reader's bones under a link still trying. A link that never starts trying settles
 * after `quiet`; any link by `limit`, whatever it does.
 */
export function retryLink(environmentId: string, limit = 20_000, quiet = 2_000): Promise<void> {
  return new Promise((resolve) => {
    let seen = false;
    let off = (): void => {};
    const done = (): void => {
      off();
      clearTimeout(timer);
      clearTimeout(still);
      resolve();
    };
    const timer = setTimeout(done, limit);
    const still = setTimeout(() => seen || done(), quiet);
    const check = (): void => {
      const transport = registry.statusOf(environmentId).transport;
      if (TRYING.has(transport)) seen = true;
      else if (seen || transport === "open") done();
    };
    off = registry.subscribe(check);
    registry.retry(environmentId);
    check();
  });
}
