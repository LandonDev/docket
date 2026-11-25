import { describe, expect, it } from "vitest";
import { offlinePrefix, wipeOffline } from "./offline";

/** A browser's IndexedDB as far as the page uses it: what it lists and what was deleted. */
const browser = (names: string[], lists = true) => {
  const deleted: string[] = [];
  const idb = {
    ...(lists ? { databases: async () => names.map((name) => ({ name })) } : {}),
    deleteDatabase(name: string) {
      deleted.push(name);
      const req: { onsuccess?: () => void } = {};
      queueMicrotask(() => req.onsuccess?.());
      return req;
    },
  } as unknown as IDBFactory;
  return { idb, deleted };
};

describe("the copy an Edit link's page keeps on the guest's device", () => {
  it("is kept under the link's own name, so no other link's page reads it", () => {
    expect(offlinePrefix("L1")).toBe("tempcode-guest:L1");
  });

  it("is wiped whole when the link is over: the document named, and any other copy this browser lists for the link, and no other link's", async () => {
    const { idb, deleted } = browser(["tempcode-guest:L1:kdocrun", "tempcode-guest:L1:file:abc", "tempcode-guest:L10:kdocrun", "tempcode-guest:L2:kdocrun", "something-else"]);
    await wipeOffline("L1", "kdocrun", idb);
    expect(deleted.sort()).toEqual(["tempcode-guest:L1:file:abc", "tempcode-guest:L1:kdocrun", "tempcode-guest:L1:sheet"]);
  });

  it("wipes the document it was told of and a sheet's unsent edits in a browser that lists nothing, and does nothing where there is no IndexedDB", async () => {
    const { idb, deleted } = browser([], false);
    await wipeOffline("L1", "kdocrun", idb);
    expect(deleted.sort()).toEqual(["tempcode-guest:L1:kdocrun", "tempcode-guest:L1:sheet"]);
    await wipeOffline("L1", undefined, idb);
    expect(deleted).toHaveLength(3);
    await expect(wipeOffline("L1", "kdocrun", undefined)).resolves.toBeUndefined();
  });
});
