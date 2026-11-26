import { useCallback, useEffect, useRef, useState } from "react";
import type { PlayInputs, PlayRow } from "@shared/contract-work-routines";
import { loadToast } from "../../../components/ui/toaster";
import { registry } from "../../../lib/connection";
import { nameInLine } from "../../../lib/hostWords";
import { workErrorWords } from "../../../lib/workErrorWords";
import { workOpenPort, workSwitch } from "../../../lib/workSwitch";

/**
 * A workspace's plays from its host, kept live by the `work.routines.plays`
 * push, and the one start every screen uses: the host makes the thread, and
 * the window opens it.
 */

/**
 * Why a list from a workspace's host did not come, in his words and naming the computer: `workErrorWords` for a
 * known fault, else "<Host> could not list the <what>." (never the link's own text).
 */
export function loadFailure(env: string, err: unknown, what: string): string {
  const name = registry.environment(env)?.name;
  const host = name ? nameInLine(name) : undefined;
  const Host = host ? host.charAt(0).toUpperCase() + host.slice(1) : "The computer this workspace runs on";
  return workErrorWords(err, { host }) || `${Host} could not list the ${what}.`;
}

/** `failed`: a read after one that landed did not answer; its rows are kept under the failure (DESIGN "Loading and empty states"). */
export type Load<T> = { status: "loading" } | { status: "ready"; value: T; failed?: string } | { status: "error"; error: string };

/** A failed read: the rows last read stay under it, if any; none, and the failure is the view. */
export const failedOver = <T,>(prev: Load<T[]>, error: string): Load<T[]> =>
  prev.status === "ready" && prev.value.length ? { status: "ready", value: prev.value, failed: error } : { status: "error", error };

/**
 * Each workspace's plays as last read, in this window's memory: Plays opens on them while the host answers (their
 * names and steps only; at most PLAYS_KEPT_MOST workspaces, dropped with Work off). The live answer replaces them.
 */
const playsKept = new Map<string, PlayRow[]>();
const PLAYS_KEPT_MOST = 16;
workSwitch.subscribe(() => {
  if (!workSwitch.anyOn()) playsKept.clear();
});
/** Tests: nothing kept. */
export const forgetPlays = (): void => playsKept.clear();

export function usePlays(env: string, workspaceId: string): [Load<PlayRow[]>, () => Promise<void>] {
  const [state, setState] = useState<Load<PlayRow[]>>(() => {
    const kept = playsKept.get(`${env}|${workspaceId}`);
    return kept ? { status: "ready", value: kept } : { status: "loading" };
  });
  // The read the effect holds, for Retry: what is shown, a failure too, stays until it answers.
  const read = useRef<() => Promise<void>>(() => Promise.resolve());
  useEffect(() => {
    const link = registry.linkOf(env);
    let live = true;
    // Several pushes ask in a row: only the newest answer is shown.
    let asked = 0;
    const fetch = (): Promise<void> => {
      const mine = ++asked;
      return link.request<{ plays: PlayRow[] }>("work.routines.plays", { workspaceId }).then(
        (r) => {
          const key = `${env}|${workspaceId}`;
          playsKept.delete(key);
          playsKept.set(key, r.plays);
          while (playsKept.size > PLAYS_KEPT_MOST) playsKept.delete(playsKept.keys().next().value!);
          if (live && mine === asked) setState({ status: "ready", value: r.plays });
        },
        (err: unknown) => void (live && mine === asked && setState((prev) => failedOver(prev, loadFailure(env, err, "plays")))),
      );
    };
    read.current = fetch;
    void fetch();
    const off = link.onPush((push) => {
      if (push.push === "work.routines.plays" && push.workspaceId === workspaceId) void fetch();
    });
    const offOpen = link.onOpen?.(() => void fetch());
    return () => {
      live = false;
      off();
      offOpen?.();
    };
  }, [env, workspaceId]);
  const retry = useCallback(() => read.current(), []);
  return [state, retry];
}

/** Starts the play and opens its thread; a refusal comes back in the host's words. */
export async function startPlay(env: string, playId: string, inputs: PlayInputs): Promise<void> {
  try {
    const { sessionId, loose } = await registry.linkOf(env).request<{ sessionId: string; loose?: string }>("work.routines.playStart", { id: playId, inputs });
    workOpenPort.get()?.(sessionId);
    // A task's project that could not take the thread (finished, out of reach): it started loose, said in one quiet line.
    if (loose) void loadToast().then((api) => api(loose));
  } catch (err) {
    throw new Error(workErrorWords(err) || "The host did not start it");
  }
}
