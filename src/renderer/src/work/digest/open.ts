import type { TellOpen, TellRow } from "@shared/work/tell";
import type { OpenWorkView } from "../../lib/workSwitch";

/**
 * Where a press on a tell goes (docs/agents/work-digest.md): a `TellOpen`
 * turned into one of the app's own routes. Pure; the host component runs it.
 */

export type Route =
  | { to: "thread"; sessionId: string }
  | { to: "view"; view: OpenWorkView }
  | { to: "place"; id: string; at?: string }
  /** `item` is the Outbox's own key for the held item, when the host is known */
  | { to: "outbox"; item?: string }
  | { to: "settings"; section: string }
  /** nothing to open */
  | { to: "none" };

/** Which field of `openWorkView` a view takes its `at` in. */
const VIEW_AT: Record<string, "event" | "mail" | "task" | "project" | "person"> = {
  agenda: "event",
  prep: "event",
  mail: "mail",
  tasks: "task",
  projects: "project",
  people: "person",
};

export function routeOf(row: Pick<TellRow, "open" | "host"> & { environmentId?: string }): Route {
  const open: TellOpen | undefined = row.open;
  if (!open) return { to: "none" };
  // A held item names its thread too: the item is what opens.
  // The Outbox keys an item by the link it came over ("local" for this machine's own), not the host's own id.
  if ("held" in open) return { to: "outbox", item: `${row.environmentId ?? row.host}:${open.held.at}:${open.held.id}` };
  if ("thread" in open) return { to: "thread", sessionId: open.thread };
  if ("view" in open) {
    const view: OpenWorkView = { workspaceId: open.workspaceId, view: open.view };
    const field = VIEW_AT[open.view];
    if (open.at && field) view[field] = open.at;
    return { to: "view", view };
  }
  if ("place" in open) return { to: "place", id: open.place, ...(open.at ? { at: open.at } : {}) };
  return { to: "settings", section: open.settings };
}

/** What runs a route: the app's own ways in, handed over by the host component. */
export interface Routes {
  thread(sessionId: string): void;
  view(view: OpenWorkView): void;
  /** false: this build has no such page */
  place(id: string, at?: string): boolean;
  outbox(item?: string): void;
  settings(section: string): void;
}

/** Runs the route; false when there was nothing to open. */
export function go(route: Route, routes: Routes): boolean {
  switch (route.to) {
    case "thread":
      routes.thread(route.sessionId);
      return true;
    case "view":
      routes.view(route.view);
      return true;
    case "place":
      return routes.place(route.id, route.at);
    case "outbox":
      routes.outbox(route.item);
      return true;
    case "settings":
      routes.settings(route.section);
      return true;
    case "none":
      return false;
  }
}
