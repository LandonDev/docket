import type { ComputersAnswer, SetupItems, SetupLinkRow, SetupPeek, SetupState, SetupStep, SetupStepRow } from "@server/shared/contract-devices";
import { registry } from "./connection";
import type { ServerPush } from "./tcserver/types";

/**
 * The window's one way to the computers and the setup link (contract-devices.ts):
 * every method and push name lives here, so the screens never spell them. Each
 * is local to the window's own host. The link travels in a request body and is
 * kept nowhere here.
 */

type Link = { request<T>(method: string, params?: unknown): Promise<T>; onPush(fn: (push: ServerPush) => void): () => void };

/** The link the screens speak on: this window's own host. Tests swap `get`. */
export const devicesLink = { get: (): Link => registry.primary() };

const call = <T>(method: string, params: unknown = {}): Promise<T> => devicesLink.get().request<T>(method, params);

export const readComputers = (): Promise<ComputersAnswer> => call("devices.computers");
export const actOnComputer = (envId: string, action: "stop" | "start" | "remove" | "retry"): Promise<{ ok: boolean }> =>
  call("devices.computer", { envId, action });

// The giver's side.
export type MadeLink = { link: string; expiresAt: number; pairingId: string };
export const makeSetupLink = (params: { name: string; items: SetupItems; workspaces: string[]; seeds?: { appearance?: unknown; defaultModels?: unknown } }): Promise<MadeLink> =>
  call("devices.setup.make", params);
export const cancelSetupLink = (pairingId: string): Promise<unknown> => call("devices.setup.cancel", { pairingId });
export const allowComputer = (pairingId: string): Promise<unknown> => call("devices.setup.allow", { pairingId });
export const denyComputer = (pairingId: string): Promise<unknown> => call("devices.setup.deny", { pairingId });
/** This Mac's open links: a claim still waiting for Allow comes back after a reload. */
export const readSetupLinks = (): Promise<{ links: SetupLinkRow[] }> => call("devices.setup.links");

// The computer's side.
export const peekSetupLink = (link: string): Promise<SetupPeek> => call("devices.setup.peek", { link });
export const startSetup = (link: string): Promise<unknown> => call("devices.setup.start", { link });
export const readSetupState = (): Promise<SetupState | null> => call("devices.setup.state");
export const retrySetupStep = (step: SetupStep): Promise<unknown> => call("devices.setup.retry", { step });
export const giveSetupFolders = (paths: string[]): Promise<unknown> => call("devices.setup.folders", { paths });

export type AllowNotice = { pairingId: string; name: string; words: string[] };
/** A step that moved; the Allow step brings the three words once the claim is made. */
export type StepPush = SetupStepRow & { words?: string[] };

/** The pushes the screens hear: a computer's news, a claim to allow, a step that moved. */
export function onDevicesPush(handlers: {
  computers?: () => void;
  allow?: (notice: AllowNotice) => void;
  link?: (link: SetupLinkRow) => void;
  step?: (step: StepPush) => void;
}): () => void {
  return devicesLink.get().onPush((push) => {
    if (push.push === "device-acked" || push.push === "device-joined" || push.push === "device-gone") handlers.computers?.();
    else if (push.push === "device-allow") handlers.allow?.({ pairingId: push.pairingId, name: push.name, words: push.words });
    else if (push.push === "device-link") handlers.link?.(push.link);
    else if (push.push === "device-setup")
      handlers.step?.({ step: push.step, state: push.state, ...(push.reason ? { reason: push.reason } : {}), ...(push.words ? { words: push.words } : {}) });
  });
}
