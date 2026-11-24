import type { ComputerRow, ComputersAnswer } from "@server/shared/contract-devices";

/** The Computers group's states for ui:preview: loading, failed, empty, the giver's list, and a computer's other states. */
const NOW = 1_800_000_000_000;
const pc = (over: Partial<ComputerRow>): ComputerRow => ({
  envId: "env_pc",
  name: "Purdue laptop",
  state: "active",
  holds: [
    { service: "claude-code", account: "u1" },
    { service: "claude-code", account: "u2" },
    { service: "codex", account: "c1" },
    { service: "meta", account: "m1" },
  ],
  syncedAt: NOW - 3 * 60_000,
  paused: false,
  waitingForContact: false,
  lastError: null,
  ...over,
});
const answer = (computers: ComputerRow[]): ComputersAnswer => ({
  computers,
  giver: { keyId: "k_mac", identity: { signPublic: "s", sealPublic: "x" }, name: "Landon's MacBook", at: 1 },
  box: { envId: "env_box", name: "box", holds: [{ service: "claude-code", account: "u1" }, { service: "codex", account: "c1" }], syncedAt: NOW - 60_000 },
});
const base = { error: null, giverHere: true, onRetry: () => {}, onSetUp: () => {}, onUseLink: () => {}, onAct: async () => {}, now: NOW };

export default [
  { name: "Loading", props: { ...base, answer: null } },
  { name: "Failed", props: { ...base, answer: null, error: "The box did not answer" } },
  { name: "No computers (a computer with a link to use)", props: { ...base, giverHere: false, answer: { computers: [], giver: null, box: null } } },
  { name: "The giver's list", props: { ...base, answer: answer([pc({})]) } },
  {
    name: "Stopped, paused, removing, a failed post",
    props: {
      ...base,
      answer: answer([
        pc({ state: "stopped" }),
        pc({ envId: "env_two", name: "Lab PC", paused: true, syncedAt: NOW - 3 * 86_400_000 }),
        pc({ envId: "env_three", name: "Old laptop", state: "removing", waitingForContact: true }),
        pc({ envId: "env_four", name: "Desk PC", holds: [], syncedAt: null, lastError: "The box refused the letter: stale seq" }),
      ]),
    },
  },
];
