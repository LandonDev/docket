/**
 * The copy an Edit link's page keeps on the guest's own device (docs/agents/work-guests.md "The copy on a guest's
 * device"): the document as this browser last held it, so words typed while the line is down outlive a closed tab
 * and are sent when the page next opens. Kept by the link, never for a View or Comment link, and wiped when the
 * link ends, when the host refuses what the copy holds, and when an update too large to send is stuck in it.
 */

/** The prefix the editor's copy is kept under; the editor adds the document's name. */
export const offlinePrefix = (linkId: string): string => `tempcode-guest:${linkId}`;

/** Deletes every copy kept for a link: the document named, a sheet's unsent edits, and any other this browser lists under the link's prefix. */
export async function wipeOffline(linkId: string, doc?: string, idb: IDBFactory | undefined = typeof indexedDB === "undefined" ? undefined : indexedDB): Promise<void> {
  if (!idb) return;
  const prefix = `${offlinePrefix(linkId)}:`;
  // A sheet's unsent edits are kept under one name a link (sheetQueue.ts `queueName`).
  const names = new Set<string>([`${prefix}sheet`, ...(doc ? [`${prefix}${doc}`] : [])]);
  try {
    for (const db of (await idb.databases?.()) ?? []) if (db.name?.startsWith(prefix)) names.add(db.name);
  } catch {
    // A browser that lists none: the named one is deleted.
  }
  await Promise.all(
    [...names].map(
      (name) =>
        new Promise<void>((resolve) => {
          const req = idb.deleteDatabase(name);
          req.onsuccess = req.onerror = req.onblocked = () => resolve();
        }),
    ),
  );
}
