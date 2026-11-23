import { CHIP_NOUN, type ChipKind } from "@shared/work";
import type { SentChip } from "./sentChipsOf";
import { sessionStore } from "../../lib/tcserver/store";
import { useProjects } from "../../lib/tcserver/workspaces";
import { openWorkView } from "../../lib/workSwitch";
import { loadToast } from "../../components/ui/toaster";
import { TruncateTip } from "../../components/tip";
import { Layers } from "../../chrome/icons";
import { CHIP_GLYPH } from "./ComposerChips";
import { openHeld } from "./held";
import { openItem } from "./store";

/**
 * What a sent message was about, in its bubble over his words
 * (docs/DESIGN.md "A chip in the composer"): the composer's chips as they
 * went, each a 24px chip with its kind's glyph and label. A chip that names
 * something this window can show opens it: a canvas item or a LifeOS
 * document in the thread's pane, a held act in the Outbox, a task, mail or
 * event in its workspace's view, a project or a project's card in the Projects
 * view, a person on their page in People. One that names nothing to open (a
 * selection's file) is a label.
 */

const KIND_OF_NOUN = new Map<string, ChipKind>(Object.entries(CHIP_NOUN).map(([kind, noun]) => [noun, kind as ChipKind]));
const VIEW_OF_TABLE: Record<string, string> = { tasks: "tasks", mailThreads: "mail", events: "agenda" };

/** What a chip's reference opens, or null for one with nothing to open here. */
export function openerOf(chip: SentChip, at: { environmentId: string; sessionId: string; workspaceId: string | null }): (() => Promise<unknown> | void) | null {
  const [head, table, id, ...more] = chip.ref.split(" ");
  if (!id || more.length > 0) return null;
  if (head === "LifeOS" && table === "docs") return () => openItem(at.environmentId, at.sessionId, { kind: "document", source: { at: "lifeos", table: "docs", id }, title: chip.label });
  // A project and a project's card open in the Projects view, on the project's page and the task's own.
  if (head === "LifeOS" && table === "projects" && at.workspaceId) return () => openWorkView({ workspaceId: at.workspaceId!, view: "projects", project: id });
  if (head === "LifeOS" && table === "tasks" && KIND_OF_NOUN.get(chip.noun) === "card" && at.workspaceId) return () => openWorkView({ workspaceId: at.workspaceId!, view: "projects", task: id });
  // A person opens on their page in People.
  if (head === "LifeOS" && table === "people" && at.workspaceId) return () => openWorkView({ workspaceId: at.workspaceId!, view: "people", person: id });
  // A mail opens in Mail's reader, on that mail.
  if (head === "LifeOS" && table === "mailThreads" && at.workspaceId) return () => openWorkView({ workspaceId: at.workspaceId!, view: "mail", mail: id });
  // A conversation opens in Messages, on that conversation.
  if (head === "LifeOS" && table === "chats" && at.workspaceId) return () => openWorkView({ workspaceId: at.workspaceId!, view: "messages", chat: id });
  if (head === "LifeOS" && VIEW_OF_TABLE[table] && at.workspaceId) return () => openWorkView({ workspaceId: at.workspaceId!, view: VIEW_OF_TABLE[table] });
  if (head === "canvas" && table === "item") return () => openItem(at.environmentId, at.sessionId, { itemId: id });
  if (head === "Work" && table === "outbox") return () => openHeld({ at: "host", id }, at.environmentId);
  if (head === "Work" && table === "routines" && at.workspaceId) return () => openWorkView({ workspaceId: at.workspaceId!, view: "routines" });
  return null;
}

const CHIP = "flex h-6 max-w-full min-w-0 items-center gap-1.5 rounded-md bg-muted px-2 text-xs text-foreground";

export function SentChips({ chips, sessionId, environmentId }: { chips: readonly SentChip[]; sessionId: string; environmentId: string }) {
  const projects = useProjects();
  const meta = sessionStore.metaOf(sessionId);
  const workspaceId = (meta?.projectId ? projects.find((p) => p.id === meta.projectId)?.workspaceId : null) ?? meta?.workspaceId ?? null;
  return (
    <ul data-sent-chips aria-label="About" className="flex flex-wrap gap-1">
      {chips.map((chip, index) => {
        const kind = KIND_OF_NOUN.get(chip.noun);
        const Glyph = (kind && CHIP_GLYPH[kind]) || Layers;
        const open = openerOf(chip, { environmentId, sessionId, workspaceId });
        const body = (
          <>
            <Glyph className="size-3 shrink-0 text-muted-foreground" />
            <TruncateTip text={chip.label}>
              <span className="min-w-0 truncate">{chip.label}</span>
            </TruncateTip>
          </>
        );
        return (
          <li key={`${index}:${chip.ref}`} data-chip={kind ?? chip.noun} className="flex min-w-0">
            {open ? (
              <button
                type="button"
                className={`${CHIP} cursor-default transition-[background-color,scale] duration-(--dur-fast) ease-(--ease-out) hover:bg-accent active:scale-[0.96]`}
                onClick={() =>
                  void Promise.resolve()
                    .then(open)
                    .catch(async () => (await loadToast()).error(`Couldn't open the ${chip.noun}`))
                }
              >
                {body}
              </button>
            ) : (
              <span className={CHIP}>{body}</span>
            )}
          </li>
        );
      })}
    </ul>
  );
}
