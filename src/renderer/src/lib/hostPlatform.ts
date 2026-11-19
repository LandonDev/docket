import { useSyncExternalStore } from "react";
import { LOCAL_ENVIRONMENT_ID, registry } from "./connection/registry";
import { nativePlatform } from "./native";

/**
 * A host's platform (`process.platform`), for its glyph: what its live hello
 * says (`build.platform`), else what the saved host remembered from the last
 * one (so a launch-mirror paint has it), else, for this machine, preload's.
 * Undefined while nothing is known.
 */
export function platformOf(environmentId: string): string | undefined {
  const hello = registry.statusOf(environmentId).lastHello?.build?.platform;
  if (hello) return hello;
  const saved = registry.environment(environmentId)?.platform;
  if (saved) return saved;
  if (environmentId === LOCAL_ENVIRONMENT_ID) return nativePlatform() || undefined;
  return undefined;
}

const subscribe = (fn: () => void) => registry.subscribe(fn);

/** The platform of one host, live; a row re-renders only when it changes. */
export function useHostPlatform(environmentId: string | undefined): string | undefined {
  return useSyncExternalStore(subscribe, () => (environmentId ? platformOf(environmentId) : undefined));
}

/** What a host is, for its glyph: a Mac, a Windows PC, or a server (Linux, and a host nothing is known of yet). */
export type HostKind = "mac" | "pc" | "server";

export function hostKind(platform: string | undefined): HostKind {
  return platform === "darwin" ? "mac" : platform === "win32" ? "pc" : "server";
}
