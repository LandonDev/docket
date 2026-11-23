import type { CanvasItem, CanvasKind } from "@shared/work";
import type { MenuIcon } from "../../chrome/menuRows";

/**
 * Verbs a pillar adds to an item's More menu in the canvas pane
 * (docs/agents/work-canvas.md): Money's File as receipt on a PDF or a
 * picture. A pillar registers its verb when its own module graph loads; the
 * pane's More reads `itemVerbsFor` once, after its own rows and before Close.
 * The pane runs a verb with the host the item lives on.
 */

export interface ItemVerb {
  id: string;
  label: string;
  icon?: MenuIcon;
  /** Whether the verb is offered for this item, of this kind. */
  when(item: CanvasItem, kind: CanvasKind): boolean;
  run(item: CanvasItem, at: { environmentId: string }): void | Promise<void>;
}

const verbs: ItemVerb[] = [];

/** Adds a verb, or puts it in the place of one with its id; answers its removal. */
export function registerItemVerb(verb: ItemVerb): () => void {
  const at = verbs.findIndex((v) => v.id === verb.id);
  if (at >= 0) verbs[at] = verb;
  else verbs.push(verb);
  return () => {
    const i = verbs.indexOf(verb);
    if (i >= 0) verbs.splice(i, 1);
  };
}

/** The verbs offered for an item, in the order they were registered. */
export function itemVerbsFor(item: CanvasItem, kind: CanvasKind): ItemVerb[] {
  return verbs.filter((v) => {
    try {
      return v.when(item, kind);
    } catch {
      return false;
    }
  });
}
