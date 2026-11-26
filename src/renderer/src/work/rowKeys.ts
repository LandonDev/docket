import type { KeyboardEvent } from "react";
import { bareKey } from "../lib/keys";

/**
 * ↑ and ↓ between a Work list's rows, one behaviour for every list (Tasks, Agenda, People, a meeting's page): the row
 * that holds focus is found by `row`, and the press moves focus to the row before or after it (to the part `focus`
 * names inside it, else the row itself). Nothing moves, and the key is left alone, where focus is in no row of this
 * list: a menu a row opened is portalled out of it, so its own arrows still work. Returns the row moved to, null at
 * either end (where the caller may go further, as People's list goes up to its search), undefined when it did nothing.
 */
export function moveBetweenRows(e: KeyboardEvent<HTMLElement>, row: string, focus?: string): HTMLElement | null | undefined {
  if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return undefined;
  if (!bareKey(e)) return undefined;
  const at = (e.target as HTMLElement).closest<HTMLElement>(row);
  if (!at || !e.currentTarget.contains(at)) return undefined;
  const all = [...e.currentTarget.querySelectorAll<HTMLElement>(row)];
  const next = all[all.indexOf(at) + (e.key === "ArrowDown" ? 1 : -1)];
  e.preventDefault();
  const target = next && focus ? (next.querySelector<HTMLElement>(focus) ?? next) : next;
  target?.focus();
  return target ?? null;
}
