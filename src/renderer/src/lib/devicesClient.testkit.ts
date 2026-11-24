import type { ServerPush } from "./tcserver/types";
import { devicesLink } from "./devicesClient";

/** A stand-in for the window's own host: answers by method, records calls, and pushes on demand. */
export function fakeDevicesLink(answer: (method: string, params: unknown) => unknown) {
  const calls: { method: string; params: unknown }[] = [];
  const listeners = new Set<(push: ServerPush) => void>();
  const original = devicesLink.get;
  devicesLink.get = () => ({
    request: async <T,>(method: string, params?: unknown): Promise<T> => {
      calls.push({ method, params });
      const out = answer(method, params);
      if (out instanceof Error) throw out;
      return out as T;
    },
    onPush: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  });
  return {
    calls,
    methods: () => calls.map((c) => c.method),
    push: (push: ServerPush) => listeners.forEach((fn) => fn(push)),
    restore: () => {
      devicesLink.get = original;
    },
  };
}
