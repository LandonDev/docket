import { useEffect, useMemo, useRef, useState } from "react";
import type { ContextChip } from "@shared/work";
import type { MailChatFound } from "@shared/contract-work-mail";
import { TruncateTip } from "../../../components/tip";
import { registry } from "../../../lib/connection";
import { chipPort } from "../../../lib/contextChips";
import { newSession, type Session } from "../../../lib/session";
import { sessionStore } from "../../../lib/tcserver/store";
import { useSessionActions } from "../../../surfaces/threadChat";
import { Dock, DockHeadControls } from "../../dock/Dock";
import type { DockWorkspace } from "../../dock/dockThread";
import type { DockSubject } from "../../dock/subject";
import { starters, type StarterFacts } from "./starters";
import type { MailChatSubject } from "./subject";

/**
 * The chat beside the mail (docs/agents/work-mail.md "The chat beside the mail", docs/DESIGN.md "The Mail view"):
 * the shared dock (work/dock) about what Mail shows. Its 44px head, level with the list's head and the reader's
 * toolbar, names the subject; no chip sits in the composer, since the head already says it, and the first send
 * carries the subject's chip itself. Before that send the host marks the new thread a mail chat
 * (`work.mail.chat.adopt`, a must step), so its first turn already has a mail chat's narrow powers.
 */
export function MailDock({
  workspace,
  subject,
  facts,
  chip,
  focus,
  onChipTaken,
  onClose,
}: {
  workspace: DockWorkspace;
  subject: MailChatSubject;
  /** what the starters are made from */
  facts: Omit<StarterFacts, "kind">;
  /** chips put in the composer on purpose (a selection's Ask, Mention in a thread) */
  chip: ContextChip | readonly ContextChip[] | null;
  focus: boolean;
  onChipTaken(): void;
  onClose(): void;
}) {
  const dockSubject = useMemo(() => mailDockSubject(workspace, subject), [workspace, subject]);
  const rows = starters({ kind: subject.kind, ...facts });
  return (
    <Dock
      name="mail"
      workspace={workspace}
      subject={dockSubject}
      chip={chip}
      focus={focus}
      onChipTaken={onChipTaken}
      onClose={onClose}
      composerTop={(id) => (rows.length ? <Starters sessionId={id} rows={rows} /> : null)}
      head={(head) => (
        <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border ps-4 pe-2">
          <TruncateTip text={subject.title}>
            <h3 className="min-w-0 flex-1 truncate text-[13px] leading-5 font-medium text-foreground">{subject.title}</h3>
          </TruncateTip>
          <DockHeadControls {...head} />
        </header>
      )}
    />
  );
}

/** Mail's subject for the shared dock: its chip on the first send, its thread found again, the host told first. */
export function mailDockSubject(workspace: DockWorkspace, subject: MailChatSubject): DockSubject {
  const link = () => registry.linkOf(workspace.environmentId);
  return {
    key: subject.key,
    title: subject.title,
    chips: [subject.chip],
    chipIn: "send",
    find: async () => {
      if (!subject.mailThreadId) return null;
      const found = await link().request<MailChatFound>("work.mail.chat.find", { workspaceId: workspace.id, mailThreadId: subject.mailThreadId });
      // A thread this window does not know, or one he archived, is not shown again.
      return found.sessionIds.find((id) => {
        const meta = sessionStore.metaOf(id);
        return !!meta && !meta.archived;
      }) ?? null;
    },
    hold: async (sessionId) => {
      await link().request("work.mail.chat.adopt", {
        workspaceId: workspace.id,
        sessionId,
        kind: subject.kind,
        ...(subject.mailThreadId ? { mailThreadId: subject.mailThreadId } : {}),
      });
    },
    mustHold: true,
    seed: onClaude,
  };
}

/**
 * A mail chat runs where its harness can be narrowed (no shell, no web): a Muse default cannot, and the Muse driver
 * refuses a mail chat, so its draft starts on Claude's default model instead.
 */
export function onClaude(draft: Session): Session {
  if (draft.harness !== "muse") return draft;
  const claude = newSession(draft.environmentId, "claude", draft.cwd, undefined, draft.runtimeMode, undefined, { projectId: draft.projectId, workspaceId: draft.workspaceId });
  return { ...draft, harness: claude.harness, model: claude.model, modelSettings: claude.modelSettings, title: claude.title };
}

/**
 * The few things a fresh chat offers to ask, quiet rows over the composer: a press sends that text. They show only
 * on a draft with nothing typed, and go once he types or the thread exists.
 */
function Starters({ sessionId, rows }: { sessionId: string; rows: string[] }) {
  const actions = useSessionActions();
  const root = useRef<HTMLDivElement>(null);
  const [typed, setTyped] = useState(false);
  const draft = sessionStore.isDraft(sessionId) && (sessionStore.get(sessionId)?.blocks.length ?? 0) === 0;
  useEffect(() => {
    // The composer is the dock's: its words are read where they are typed.
    const dock = root.current?.closest("section");
    if (!dock) return;
    const read = (): void => setTyped(!!dock.querySelector("[data-composer-input]")?.textContent?.trim());
    read();
    dock.addEventListener("input", read);
    return () => dock.removeEventListener("input", read);
  }, []);
  if (!draft || typed) return <div ref={root} hidden />;
  const send = (text: string): void => actions.onSubmit(sessionId, chipPort.get()?.send(sessionId, true, text) || text, []);
  return (
    <div ref={root} data-mail-starters className="mb-2 flex flex-col">
      {rows.map((text) => (
        <button
          key={text}
          type="button"
          onClick={() => send(text)}
          className="flex h-8 items-center rounded-md px-2 text-start text-[13px] text-muted-foreground transition-colors duration-(--dur-fast) ease-(--ease-out) outline-none hover:text-foreground focus-visible:text-foreground focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
        >
          {text}
        </button>
      ))}
    </div>
  );
}
