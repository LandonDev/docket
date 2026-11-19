import { useEffect, useRef, useState } from "react";
import type { DraftProposals, HouseRule, RuleProposal, RulesPage, VoiceFacts } from "@shared/contract-work-rules";
import { registry } from "../../lib/connection";
import { refusalWords } from "../../lib/settingsHome";

/**
 * What the rules screens ask of the workspace's host (docs/agents/work-rules.md):
 * the page's rules and proposals, a sent draft's proposals, the voice facts,
 * and the owner's own presses. Each refusal comes back as the host's sentence.
 */

const ask = <T>(env: string, method: string, params: Record<string, unknown>): Promise<T> => registry.linkOf(env).request<T>(method, params);

export const addRule = (env: string, workspaceId: string, text: string, proposalId?: string) =>
  ask<HouseRule>(env, "work.rules.add", { workspaceId, text, ...(proposalId ? { proposalId } : {}) });
export const editRule = (env: string, id: string, patch: { text?: string; on?: boolean }) => ask<HouseRule>(env, "work.rules.edit", { id, ...patch });
export const removeRule = (env: string, id: string, reopen = false) => ask<{ removed: boolean }>(env, "work.rules.remove", { id, ...(reopen ? { reopen } : {}) });
export const orderRules = (env: string, workspaceId: string, ids: readonly string[]) => ask<{ ok: true }>(env, "work.rules.order", { workspaceId, ids });
export const decideProposal = (env: string, id: string, to: "open" | "later" | "dismissed") => ask<RuleProposal | null>(env, "work.rules.decide", { id, to });

export type Load<T> = { status: "loading" } | { status: "ready"; value: T } | { status: "error"; error: string };

/**
 * A read that asks again on every `work.rules` push for the workspace; only
 * the newest answer is shown. A new key starts from loading, so one
 * workspace's rows never stand on another's page; `put` sets an answer in
 * place (an optimistic order) and outranks any read still in flight.
 */
function usePushed<T>(env: string | undefined, key: string | null, read: () => Promise<T>, heard: (workspaceId: string) => boolean): [Load<T>, (value: T) => void] {
  const [state, setState] = useState<{ key: string | null; load: Load<T> }>({ key, load: { status: "loading" } });
  const asked = useRef(0);
  useEffect(() => {
    if (!env || !key) return;
    const link = registry.linkOf(env);
    let live = true;
    setState({ key, load: { status: "loading" } });
    const fetch = (): void => {
      const mine = ++asked.current;
      read().then(
        (value) => live && mine === asked.current && setState({ key, load: { status: "ready", value } }),
        (err: unknown) => live && mine === asked.current && setState({ key, load: { status: "error", error: refusalWords(err) || "The host did not answer" } }),
      );
    };
    fetch();
    const off = link.onPush((push) => {
      if (push.push === "work.rules" && heard(push.workspaceId)) fetch();
    });
    return () => {
      live = false;
      off();
    };
    // `read` and `heard` follow `key`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [env, key]);
  const put = (value: T): void => {
    asked.current++;
    setState({ key, load: { status: "ready", value } });
  };
  return [state.key === key ? state.load : { status: "loading" }, put];
}

export const useRulesPage = (env: string | undefined, workspaceId: string) =>
  usePushed<RulesPage>(env, workspaceId, () => ask(env!, "work.rules.list", { workspaceId }), (id) => id === workspaceId);

export function useDraftProposals(env: string, draftId: string): Load<DraftProposals> {
  const workspace = useRef<string | null>(null);
  const [state] = usePushed<DraftProposals>(
    env,
    draftId,
    () =>
      ask<DraftProposals>(env, "work.rules.forDraft", { draftId }).then((answer) => {
        workspace.current = answer.workspaceId;
        return answer;
      }),
    // A sent mail's line hears its own workspace, or any before the host has named it.
    (id) => workspace.current === null || id === workspace.current,
  );
  return state;
}

export const useVoice = (env: string | undefined, workspaceId: string) =>
  usePushed<VoiceFacts>(env, workspaceId, () => ask(env!, "work.rules.voice", { workspaceId }), (id) => id === workspaceId);
