/** ConnectionsPreview's states for `bun run ui:preview`: both hosts answering, the Mac offline, the first check. */
export const fixtures = [
  { name: "Both hosts", props: { hosts: "both" } },
  { name: "The Mac offline", props: { hosts: "macOffline" } },
  { name: "First check", props: { hosts: "first" } },
];
