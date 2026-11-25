/**
 * The word that items closed, as the host confirmed it, for what a kind keeps of an item outside its body (a sheet's
 * book, a PDF's engine): it goes with the item. No imports, so a kind's chunk takes it without the canvas store.
 */
type Listener = (itemIds: readonly string[]) => void;
const listeners = new Set<Listener>();

export function onItemsGone(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Told by the canvas store once the host has said the items are closed. */
export function itemsGone(itemIds: readonly string[]): void {
  if (itemIds.length) for (const listener of [...listeners]) listener(itemIds);
}

/**
 * A kind's map of what it keeps per item, emptied of each item that closes. `itemOf` reads the item id from a key
 * (`env\nitem` by default, a bare item id as it is).
 */
export function forgetWithItems(map: Map<string, unknown>, itemOf: (key: string) => string = (key) => key.slice(key.indexOf("\n") + 1)): () => void {
  return onItemsGone((ids) => {
    for (const key of [...map.keys()]) if (ids.includes(itemOf(key))) map.delete(key);
  });
}

