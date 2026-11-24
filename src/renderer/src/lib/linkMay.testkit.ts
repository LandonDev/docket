import type { Capability } from "@shared/capabilities";
import type * as LinkMay from "./linkMay";

/**
 * `linkMay` in a surface's DOM test: every link answers as the key in `testKey` would, by the host's own rule
 * (`capsMay`). Mock with
 * `vi.mock("<path>/lib/linkMay", async (original) => (await import("<path>/lib/linkMay.testkit")).linkMayMock(await original()))`
 * and set `testKey.current`; null is the window's own socket, which may do everything. `testKey.of` gives one link
 * its own key.
 */
type Key = { caps: readonly Capability[]; key: { id: string } };

export const OWNER_KEY: Key = { caps: ["read", "operate", "approve", "admin"], key: { id: "owner" } };
/** What a setup link gives a computer (docs/agents/pc-setup.md). */
export const GIVEN_KEY: Key = { caps: ["operate", "approve", "device"], key: { id: "laptop" } };
export const READ_KEY: Key = { caps: ["read"], key: { id: "phone" } };

export const testKey: { current: Key | null; of: Record<string, Key | null> } = { current: null, of: {} };

/** Back to the window's own socket on every link. */
export function resetTestKey(): void {
  testKey.current = null;
  testKey.of = {};
}

export function linkMayMock(original: typeof LinkMay): typeof LinkMay {
  const may = (environmentId: string, method: Parameters<typeof LinkMay.linkMay>[1], params?: unknown): boolean =>
    original.capsMay(environmentId in testKey.of ? testKey.of[environmentId] : testKey.current, method, params);
  return { ...original, linkMay: may, useLinkMay: may, useLinksMay: () => may };
}
