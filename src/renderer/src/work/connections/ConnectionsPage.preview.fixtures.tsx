/** ConnectionsPreview's states for `bun run ui:preview`: both hosts answering, the Mac offline, the first check, neither host linked, the Mac's check run out of time, the Mac refusing, LifeOS down on both (the box's sign-in waiting, LifeOS silent on the Mac with Retry), LifeOS unreachable on the box (Retry beside Sign out) with the Mac silent on its Retry, and (last, since it makes this window a given computer) the box signed out and LifeOS silent on the Mac as his laptop sees them. */
export const fixtures = [
  { name: "Both hosts", props: { hosts: "both" } },
  { name: "The Mac offline", props: { hosts: "macOffline" } },
  { name: "First check", props: { hosts: "first" } },
  { name: "Neither host linked", props: { hosts: "offline" } },
  { name: "The Mac did not answer", props: { hosts: "macFailed" } },
  { name: "The Mac refused", props: { hosts: "macRefused" } },
  { name: "LifeOS down on both", props: { hosts: "lifeosDown" } },
  { name: "LifeOS unreachable, the Mac silent", props: { hosts: "unreachable" } },
  { name: "From a given computer", props: { hosts: "given" } },
];
