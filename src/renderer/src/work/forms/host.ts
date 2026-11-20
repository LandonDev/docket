import type { FormBody, FormMode, FormResponses, FormView } from "@shared/contract-work-forms";
import type { OutboxItem } from "@shared/contract-work-outbox";
import type { CanvasItem, CanvasSource } from "@shared/work";
import { registry } from "../../lib/connection";

/**
 * The form kind's reads and presses (docs/agents/work-forms.md "The
 * canvas"): one item's `work.forms.*` calls on the host the thread lives on,
 * and the `work.forms` push for it, asked again when the socket comes back.
 */
export interface FormHost {
  open(): Promise<FormView>;
  save(rev: number, body: FormBody): Promise<FormView>;
  /** `cleared`: the changes the decision cleared because their question went with it, as the host names them */
  review(which: { ids: string[] } | "all", verdict: "accept" | "reject"): Promise<FormView & { cleared?: string[] }>;
  mode(mode: FormMode): Promise<FormView>;
  /** Holds the publish, then presses it: the button is his press. */
  publish(): Promise<FormView>;
  close(open: boolean): Promise<FormView>;
  responses(rev?: number): Promise<FormResponses | { same: true; rev: number }>;
  openSheet(sheet: CanvasSource, title: string): Promise<void>;
  /** Every view the host pushes for this item, and a fresh one when the socket comes back. */
  watch(on: (view: FormView) => void): () => void;
}

export function linkFormHost(env: string, item: CanvasItem): FormHost {
  const link = (): ReturnType<typeof registry.linkOf> => registry.linkOf(env);
  const ask = <T>(method: string, params: Record<string, unknown> = {}): Promise<T> => link().request<T>(method, { itemId: item.id, ...params });
  return {
    open: () => ask("work.forms.open"),
    save: (rev, body) => ask("work.forms.save", { rev, body }),
    review: (which, verdict) => ask("work.forms.review", { which, verdict }),
    mode: (mode) => ask("work.forms.mode", { mode }),
    async publish() {
      const view = await ask<FormView>("work.forms.publish");
      if (!view.held) return view;
      const sent = await link().request<OutboxItem>("work.outbox.send", { ref: view.held.ref });
      const after = await ask<FormView>("work.forms.open");
      if (after.state !== "open") throw new Error(sent.state === "stale" ? "The form changed after it was held. Publish it again." : "The form was not published.");
      return after;
    },
    close: (open) => ask("work.forms.close", { open }),
    responses: (rev) => ask("work.forms.responses", rev === undefined ? {} : { rev }),
    openSheet: async (sheet, title) => {
      await link().request("work.canvas.open", { sessionId: item.sessionId, kind: "sheet", source: sheet, title });
    },
    watch(on) {
      const offPush = link().onPush((push) => {
        if (push.push === "work.forms" && push.itemId === item.id) on(push.view);
      });
      const offOpen = link().onOpen(() => void ask<FormView>("work.forms.open").then(on, () => undefined));
      return () => {
        offPush();
        offOpen();
      };
    },
  };
}
