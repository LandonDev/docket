import { useMemo } from "react";
import { MessagesDataProvider } from "./data";
import { fixtureData, JOB, manyChats, manyMessages, MESSAGES, type FixtureOptions } from "./fixtures";
import { MessagesScreen } from "./MessagesView";
import { patchPage, type MessagesPage } from "./page";

/**
 * The Messages view over made-up conversations (fixtures.ts), for `bun run ui:preview
 * src/renderer/src/work/messages/MessagesView.preview.tsx#MessagesPreview --props '{"scene":"open-direct","width":1280}'`.
 * Scenes: `list`, `list-unread`, `list-loading`, `list-empty`, `list-no-source`, `list-stale`,
 * `open-direct`, `open-channel`, `open-thread-reply`, `search`, `narrow-list`, `narrow-open`, and
 * `heavy-list` (2,000 conversations) and `heavy-open` (5,000 messages) for the speed proof. `width`
 * is the view's (1280 or 640; at and under 640 the list and the conversation take turns). Rendered
 * by nothing in the app.
 */

type Scene = { data?: FixtureOptions; page?: Partial<MessagesPage>; narrow?: boolean };

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
  "heavy-list": () => ({ data: { chats: manyChats(HEAVY_CHATS) } }),
  "heavy-open": () => {
    const chats = manyChats(HEAVY_CHATS);
    return { data: { chats, messages: { ...MESSAGES, [chats[0]!._id]: manyMessages(chats[0]!._id, HEAVY_MESSAGES) } }, page: { chatId: chats[0]!._id } };
  },
};

export const MESSAGES_SCENES = Object.keys(SCENES);

export function MessagesPreview({ scene = "list", width = 1280, height = 760 }: { scene?: string; width?: number; height?: number }) {
  const workspaceId = `preview-messages-${scene}-${width}`;
  const setup = useMemo(() => (SCENES[scene] ?? SCENES.list!)(), [scene]);
  const data = useMemo(() => fixtureData(setup.data), [setup]);
  useMemo(() => patchPage(workspaceId, { chatId: null, filter: "all", query: "", ...setup.page }), [workspaceId, setup]);
  const narrow = setup.narrow || width <= 640;
  return (
    // The view's region, as the Work frame lays it: the page's own background, a hairline round it for the shot.
    <div style={{ width, height }} className="overflow-hidden border border-border bg-background">
      <MessagesDataProvider value={data}>
        <MessagesScreen workspaceId={workspaceId} job={JOB} narrow={narrow} />
      </MessagesDataProvider>
    </div>
  );
}

