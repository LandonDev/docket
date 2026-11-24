/** ConnectionsPreview's states for `bun run ui:preview`: both hosts answering, the Mac offline, the first check, neither host linked, the Mac's check run out of time. */
export const fixtures = [
  { name: "Both hosts", props: { hosts: "both" } },
  { name: "The Mac offline", props: { hosts: "macOffline" } },
  { name: "First check", props: { hosts: "first" } },
  { name: "Neither host linked", props: { hosts: "offline" } },
  { name: "The Mac did not answer", props: { hosts: "macFailed" } },
];
