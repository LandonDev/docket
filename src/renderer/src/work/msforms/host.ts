import type { MsFormHistoryRow, MsFormResponses, MsFormView } from "@shared/contract-work-msforms";
import type { OutboxItem } from "@shared/contract-work-outbox";
import type { HeldRef } from "@shared/work";
import type { MsFormCheck } from "@shared/work/msforms";
import { registry } from "../../lib/connection";

/**
 * A Microsoft form's reads and presses (docs/agents/work-msforms.md "The
 * fenced page"): one form's `work.msforms.*` calls on the host that keeps
 * its row, and the `work.msforms` push for it, asked again when the socket
 * comes back. Collect responses is held, so its press is the hold and then
 * `work.outbox.send`, as our own form's Publish is.
 */
export interface MsFormHost {
  get(): Promise<MsFormView>;
  /** Holds Collect responses (or a reopen of a closed form), then presses it. */
  collect(): Promise<MsFormView>;
  close(open: boolean): Promise<MsFormView>;
  mode(mode: "suggests" | "writes"): Promise<MsFormView>;
  check(every: MsFormCheck): Promise<MsFormView>;
  review(accept: string[], reject: string[]): Promise<MsFormView>;
  responses(): Promise<MsFormResponses>;
  refresh(): Promise<MsFormView>;
  seen(): Promise<MsFormView>;
  /** The changes of the question list, newest first. */
  history(): Promise<MsFormHistoryRow[]>;
  /** The answers workbook as Files names it, remembered as Live in Excel for the open that follows. */
  workbook(): Promise<{ ref: { at: "file"; host: string; path: string }; name: string }>;
  watch(on: (view: MsFormView | null) => void): () => void;
}

export function linkMsFormHost(env: string, at: { workspaceId: string; formId: string }): MsFormHost {
  const link = (): ReturnType<typeof registry.linkOf> => registry.linkOf(env);
  const ask = <T>(method: string, params: Record<string, unknown> = {}, timeoutMs?: number): Promise<T> =>
    link().request<T>(method, { workspaceId: at.workspaceId, formId: at.formId, ...params }, timeoutMs ? { timeoutMs } : undefined);
  // A carrier pass on the box browser takes up to a couple of minutes: a press waits for it.
  const SLOW = 180_000;
  return {
    get: () => ask("work.msforms.get"),
    async collect() {
      const { ref } = await ask<{ ref: HeldRef; rev: number }>("work.msforms.publish");
      const sent = await link().request<OutboxItem>("work.outbox.send", { ref }, { timeoutMs: SLOW });
      const after = await ask<MsFormView>("work.msforms.get");
      if (after.state !== "collecting") throw new Error(sent.state === "stale" ? "The form changed after it was held. Collect responses again." : "The form is not collecting responses yet.");
      return after;
    },
    close: (open) => ask("work.msforms.close", { open }, SLOW),
    mode: (mode) => ask("work.msforms.mode", { mode }),
    check: (every) => ask("work.msforms.check", { every }),
    review: (accept, reject) => ask("work.msforms.review", { accept, reject }, SLOW),
    responses: () => ask("work.msforms.responses", {}, SLOW),
    refresh: () => ask("work.msforms.refresh", {}, SLOW),
    seen: () => ask("work.msforms.seen"),
    history: () => ask("work.msforms.history"),
    workbook: () => ask("work.msforms.workbook"),
    watch(on) {
      const offPush = link().onPush((push) => {
        if (push.push === "work.msforms" && push.workspaceId === at.workspaceId && push.formId === at.formId) on(push.view);
      });
      const offOpen = link().onOpen(() => void ask<MsFormView>("work.msforms.get").then(on, () => undefined));
      return () => {
        offPush();
        offOpen();
      };
    },
  };
}
