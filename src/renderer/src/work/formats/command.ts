import { useEffect, useRef, type RefObject } from "react";
import { workCommands, type WorkCommandId } from "../../lib/appCommands";

/**
 * How a kind's Body answers File → Print… and Export… and the editor's own
 * find (docs/agents/work-editors.md "Who hears a key"). The menu, the key
 * resolver and the in-app bar all end in one window event, `work:command`
 * (`workCommands.run`, lib/appCommands.ts); this is the listener. A Body
 * marks its root `data-editor-keys` and calls `useWorkCommands(root, {…})`
 * with what it answers. While it is mounted the menu's rows are live; with
 * none mounted they are greyed and the keys stay the app's.
 *
 * With several editors on screen (a split, a Files tab beside a thread) the
 * command goes to the one that holds the caret, else the one that held it
 * last, else the one mounted last.
 */

export type WorkCommandHandlers = Partial<Record<WorkCommandId, () => void>>;

interface Mounted {
  root: RefObject<HTMLElement | null>;
  handlers: RefObject<WorkCommandHandlers>;
}

const mounted: Mounted[] = [];
let last: Mounted | null = null;

function onCommand(event: Event): void {
  const id = (event as CustomEvent<{ id?: WorkCommandId }>).detail?.id;
  if (!id) return;
  const answers = mounted.filter((m) => m.handlers.current[id]);
  const active = document.activeElement;
  const target = answers.find((m) => active && m.root.current?.contains(active)) ?? (last && answers.includes(last) ? last : answers.at(-1));
  target?.handlers.current[id]?.();
}

function onFocus(event: FocusEvent): void {
  const held = mounted.find((m) => m.root.current?.contains(event.target as Node));
  if (held) last = held;
}

/** Answers the commands of `handlers` for the editor whose root is `root`, while mounted. */
export function useWorkCommands(root: RefObject<HTMLElement | null>, handlers: WorkCommandHandlers): void {
  const latest = useRef(handlers);
  latest.current = handlers;
  // The ids alone decide what is offered: a new closure each render changes nothing the menu sees.
  const ids = (Object.keys(handlers) as WorkCommandId[]).filter((id) => handlers[id]).sort().join();
  useEffect(() => {
    const me: Mounted = { root, handlers: latest };
    if (mounted.length === 0) {
      window.addEventListener("work:command", onCommand);
      document.addEventListener("focusin", onFocus);
    }
    mounted.push(me);
    const offs = ids ? (ids.split(",") as WorkCommandId[]).map((id) => workCommands.offer(id)) : [];
    return () => {
      for (const off of offs) off();
      mounted.splice(mounted.indexOf(me), 1);
      if (last === me) last = null;
      if (mounted.length === 0) {
        window.removeEventListener("work:command", onCommand);
        document.removeEventListener("focusin", onFocus);
      }
    };
  }, [root, ids]);
}
