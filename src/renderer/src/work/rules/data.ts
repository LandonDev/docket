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

/** A read that asks again on every `work.rules` push for the workspace; only the newest answer is shown. */
function usePushed<T>(env: string | undefined, key: string | null, read: () => Promise<T>, heard: (workspaceId: string) => boolean): [Load<T>, (value: T) => void] {
  const [state, setState] = useState<Load<T>>({ status: "loading" });
  useEffect(() => {
    if (!env || !key) return;
    const link = registry.linkOf(env);
    let live = true;
    let asked = 0;
    const fetch = (): void => {
      const mine = ++asked;
      read().then(
        (value) => live && mine === asked && setState({ status: "ready", value }),
        (err: unknown) => live && mine === asked && setState({ status: "error", error: refusalWords(err) || "The host did not answer" }),
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
  return [state, (value: T) => setState({ status: "ready", value })];
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

export const useVoice = (env: string | undefined, workspaceId: string, tick: unknown) =>
  usePushed<VoiceFacts>(env, `${workspaceId}:${String(tick)}`, () => ask(env!, "work.rules.voice", { workspaceId }), (id) => id === workspaceId)[0];
