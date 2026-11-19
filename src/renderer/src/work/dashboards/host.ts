import type { DashboardView, DashSheet } from "@shared/contract-work-dashboards";
import type { CanvasItem } from "@shared/work";
import { registry } from "../../lib/connection";

/**
 * The dashboard kind's reads and presses (docs/agents/work-dashboards.md
 * "The canvas"): one item's `work.dashboards.*` calls, the push for it, and
 * opening a figure's sheet beside it.
 */
export interface DashHost {
  open(): Promise<DashboardView>;
  refresh(): Promise<DashboardView>;
  review(which: { ids: string[] } | "all", verdict: "accept" | "reject"): Promise<DashboardView>;
  openSheet(sheet: DashSheet, title: string): Promise<void>;
  watch(on: (view: DashboardView) => void): () => void;
}

export function linkDashHost(env: string, item: CanvasItem): DashHost {
  const link = (): ReturnType<typeof registry.linkOf> => registry.linkOf(env);
  const ask = <T>(method: string, params: Record<string, unknown> = {}): Promise<T> => link().request<T>(method, { itemId: item.id, ...params });
  return {
    open: () => ask("work.dashboards.open"),
    refresh: () => ask("work.dashboards.refresh"),
    review: (which, verdict) => ask("work.dashboards.review", { which, verdict }),
    openSheet: async (sheet, title) => {
      await link().request("work.canvas.open", { sessionId: item.sessionId, kind: "sheet", source: sheet, title });
    },
    watch(on) {
      const offPush = link().onPush((push) => {
        if (push.push === "work.dashboards" && push.itemId === item.id) on(push.view);
      });
      const offOpen = link().onOpen(() => void ask<DashboardView>("work.dashboards.open").then(on, () => undefined));
      return () => {
        offPush();
        offOpen();
      };
    },
  };
}
