// bun run ui:preview src/renderer/src/chrome/WorkspaceSessions.preview.tsx#WorkspaceColumn (or #HomeChats and #ArchivedOpen)
// Static capture includes the real header and an open archive. Restoring a project needs interaction.
import { waitForPreview } from "../lib/previewHost.preview";

const openArchive = async (root: HTMLElement) => {
  const fold = await waitForPreview(() => [...root.querySelectorAll("button")].find((item) => item.textContent?.includes("Archived")));
  fold.click();
};

export const HomeChatsFixtures = [
  { name: "Home with no chats", props: { empty: true } },
  { name: "Home with a chat that needs an answer", props: {} },
];
export const ArchivedOpenFixtures = [{ name: "Archived projects open", props: {}, prepare: openArchive }];
export const WorkspaceColumnFixtures = [
  ...HomeChatsFixtures,
  { name: "Archived projects open", props: { archived: true }, prepare: openArchive },
];
