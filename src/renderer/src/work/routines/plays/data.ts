import { useCallback, useEffect, useState } from "react";
import type { PlayInputs, PlayRow } from "@shared/contract-work-routines";
import { registry } from "../../../lib/connection";
import { refusalWords } from "../../../lib/settingsHome";
import { workOpenPort } from "../../../lib/workSwitch";

/**
 * A workspace's plays from its host, kept live by the `work.routines.plays`
 * push, and the one start every screen uses: the host makes the thread, and
 * the window opens it.
 */

export type Load<T> = { status: "loading" } | { status: "ready"; value: T } | { status: "error"; error: string };

export function usePlays(env: string, workspaceId: string): [Load<PlayRow[]>, () => void] {
  const [state, setState] = useState<Load<PlayRow[]>>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const link = registry.linkOf(env);
    let live = true;
    // Several pushes ask in a row: only the newest answer is shown.
    let asked = 0;
    const fetch = () => {
      const mine = ++asked;
      link.request<{ plays: PlayRow[] }>("work.routines.plays", { workspaceId }).then(
        (r) => live && mine === asked && setState({ status: "ready", value: r.plays }),
        (err: unknown) => live && mine === asked && setState({ status: "error", error: refusalWords(err) || "The host did not answer" }),
      );
    };
    fetch();
    const off = link.onPush((push) => {
      if (push.push === "work.routines.plays" && push.workspaceId === workspaceId) fetch();
    });
    return () => {
      live = false;
      off();
    };
  }, [env, workspaceId, attempt]);
  const retry = useCallback(() => {
    setState({ status: "loading" });
    setAttempt((n) => n + 1);
  }, []);
  return [state, retry];
}

/** Starts the play and opens its thread; a refusal comes back in the host's words. */
export async function startPlay(env: string, playId: string, inputs: PlayInputs): Promise<void> {
  try {
    const { sessionId } = await registry.linkOf(env).request<{ sessionId: string }>("work.routines.playStart", { id: playId, inputs });
    workOpenPort.get()?.(sessionId);
  } catch (err) {
    throw new Error(refusalWords(err) || "The host did not start it");
  }
}
