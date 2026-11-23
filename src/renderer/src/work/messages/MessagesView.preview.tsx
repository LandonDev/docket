import { useMemo } from "react";
import { MessagesDataProvider } from "./data";
import { ReplyBody } from "./ChatReplyAct";
import { CHATS, COPY_DRAFT, FILE_FAILED, fixtureData, PICTURE_FAILED, HELD_DRAFT, JOB, manyChats, manyMessages, MESSAGES, withReply, type FixtureOptions } from "./fixtures";
import { MessagesScreen } from "./MessagesView";
import { keepRefusal, keepTyped, patchPage, type MessagesPage } from "./page";
import { StartThreadProvider } from "./threads";

/** Start thread in the preview: drawn, and goes nowhere. */
const startNothing = (): void => {};

/**
 * The Messages view over made-up conversations (fixtures.ts), for `bun run ui:preview
 * src/renderer/src/work/messages/MessagesView.preview.tsx#MessagesPreview --props '{"scene":"open-direct","width":1280}'`.
 * Scenes: `list`, `list-unread`, `list-loading`, `list-empty`, `list-no-source`, `list-stale`,
 * `open-direct`, `open-channel`, `open-thread-reply`, `search`, `narrow-list`, `narrow-open`, the
 * composer's `sending`, `not-sent`, `no-route`, `mac-offline`, `held-draft`, `copy-draft`, the
 * Outbox's `outbox-reply` (a held reply's body as the Outbox shows it), `open-pictures`,
 * `open-files`, `open-file-failed`, the council's `open-group`, `open-loading`, `open-failed`,
 * `list-failed`, `list-unread-empty`, `refused`, `picture-failed`, and
 * `heavy-list` (2,000 conversations) and `heavy-open` (5,000 messages) for the speed proof. `width`
 * is the view's (1280 or 640; at and under 640 the list and the conversation take turns). Rendered
 * by nothing in the app.
 */

type Scene = { data?: FixtureOptions; page?: Partial<MessagesPage>; narrow?: boolean; typed?: string; refused?: string };

const HEAVY_CHATS = 2_000;
const HEAVY_MESSAGES = 5_000;

const SCENES: Record<string, () => Scene> = {
  list: () => ({ data: { drafted: ["c_priya"] } }),
  "list-unread": () => ({ page: { filter: "unread" } }),
  "list-loading": () => ({ data: { loading: true } }),
  "list-empty": () => ({ data: { empty: true } }),
  "list-no-source": () => ({ data: { noSource: true } }),
  "list-stale": () => ({ data: { stale: true } }),
  "open-direct": () => ({ data: { drafted: ["c_priya"] }, page: { chatId: "c_dana" } }),
  "open-channel": () => ({ page: { chatId: "c_builds" } }),
  "open-thread-reply": () => ({ page: { chatId: "c_design" } }),
  search: () => ({ page: { query: "controller" } }),
  "narrow-list": () => ({ data: { stale: true }, narrow: true }),
  "narrow-open": () => ({ data: { stale: true }, page: { chatId: "c_playtest" }, narrow: true }),
  sending: () => ({ data: { messages: { ...MESSAGES, c_dana: withReply("c_dana", "queued", "Thursday is tight, but yes. I'll get it in by Wednesday night.") } }, page: { chatId: "c_dana" } }),
  "not-sent": () => ({ data: { messages: { ...MESSAGES, c_dana: withReply("c_dana", "failed", "Thursday is tight, but yes. I'll get it in by Wednesday night.", "Slack says this conversation is archived") } }, page: { chatId: "c_dana" } }),
  "no-route": () => ({ page: { chatId: "c_playtest" } }),
  "mac-offline": () => ({ data: { routes: { c_jordan: { can: false, why: "Your Mac isn't running LifeOS" } } }, page: { chatId: "c_jordan" } }),
  "held-draft": () => ({ data: { drafts: { c_dana: [HELD_DRAFT] } }, page: { chatId: "c_dana" } }),
  // A held draft where the route says no: Copy, LifeOS's reason on the draft's line, the draft kept.
  "held-draft-offline": () => ({ data: { drafts: { c_jordan: [{ ...HELD_DRAFT, id: "held_2", text: "Running ten minutes late, save me a seat by the window." }] }, routes: { c_jordan: { can: false, why: "Your Mac isn't running LifeOS" } } }, page: { chatId: "c_jordan" } }),
  // A thread's held reply whose press failed: "Not sent.", the reason, Open in Outbox; its words stay out of the field.
  "held-draft-failed": () => ({ data: { drafts: { c_dana: [{ ...HELD_DRAFT, failed: "Slack said the thread is archived" }] } }, page: { chatId: "c_dana" } }),
  // A thread's held reply whose press failed with its outcome unknown: "May have gone.", the Outbox's own words.
  "held-draft-unknown": () => ({ data: { drafts: { c_dana: [{ ...HELD_DRAFT, failed: "LifeOS did not answer in time", unknown: true }] } }, page: { chatId: "c_dana" } }),
  "copy-draft": () => ({ data: { drafts: { c_playtest: [COPY_DRAFT] } }, page: { chatId: "c_playtest" } }),
  "open-pictures": () => ({ page: { chatId: "c_art" } }),
  "open-files": () => ({ page: { chatId: "c_lucas" } }),
  "open-file-failed": () => ({ data: { messages: { ...MESSAGES, c_lucas: FILE_FAILED } }, page: { chatId: "c_lucas" } }),
  "open-group": () => ({ page: { chatId: "c_trio" } }),
  "open-loading": () => ({ data: { messagesLoading: true }, page: { chatId: "c_dana" } }),
  "open-failed": () => ({ data: { fail: { chat: 1 } }, page: { chatId: "c_dana" } }),
  "list-failed": () => ({ data: { fail: { chats: 1 } } }),
  "list-unread-empty": () => ({ data: { chats: CHATS.map((c) => ({ ...c, unread: false })) }, page: { filter: "unread" } }),
  refused: () => ({ page: { chatId: "c_dana" }, typed: "Thursday is tight, but yes.", refused: "LifeOS can't reply to a conversation you left" }),
  "picture-failed": () => ({ data: { messages: { ...MESSAGES, c_art: PICTURE_FAILED } }, page: { chatId: "c_art" } }),
  "heavy-list": () => ({ data: { chats: manyChats(HEAVY_CHATS) } }),
  "heavy-open": () => {
    const chats = manyChats(HEAVY_CHATS);
    return { data: { chats, messages: { ...MESSAGES, [chats[0]!._id]: manyMessages(chats[0]!._id, HEAVY_MESSAGES) } }, page: { chatId: chats[0]!._id } };
  },
};

export const MESSAGES_SCENES = Object.keys(SCENES);

export function MessagesPreview({ scene = "list", width = 1280, height = 760 }: { scene?: string; width?: number; height?: number }) {
  if (scene === "outbox-reply") return <OutboxReply width={width} />;
  const workspaceId = `preview-messages-${scene}-${width}`;
  const setup = useMemo(() => (SCENES[scene] ?? SCENES.list!)(), [scene]);
  const data = useMemo(() => fixtureData(setup.data), [setup]);
  useMemo(() => {
    patchPage(workspaceId, { chatId: null, filter: "all", query: "", ...setup.page });
    const chatId = setup.page?.chatId;
    if (chatId) {
      keepTyped(workspaceId, chatId, setup.typed ?? "");
      keepRefusal(workspaceId, chatId, setup.refused ?? null);
    }
  }, [workspaceId, setup]);
  const narrow = setup.narrow || width <= 640;
  return (
    // The view's region, as the Work frame lays it: the page's own background, a hairline round it for the shot.
    <div style={{ width, height }} className="overflow-hidden border border-border bg-background">
      <MessagesDataProvider value={data}>
        <StartThreadProvider value={startNothing}>
          <MessagesScreen workspaceId={workspaceId} job={JOB} narrow={narrow} />
        </StartThreadProvider>
      </MessagesDataProvider>
    </div>
  );
}


/** A held reply's body as the Outbox's detail shows it, at that column's measure. */
function OutboxReply({ width }: { width: number }) {
  const dana = CHATS.find((c) => c._id === "c_dana")!;
  return (
    <div style={{ width: Math.min(width, 720) }} className="border border-border bg-background p-6">
      <ReplyBody
        reply={{ chatId: dana._id, source: dana.source, chat: dana.name, text: HELD_DRAFT.text }}
        chat={dana}
        answered={{ who: "Dana Lee", text: dana.lastText }}
      />
    </div>
  );
}
