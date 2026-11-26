import type { SetupPeek, SetupState } from "@server/shared/contract-devices";

/** The computer's setup screens for ui:preview: the first screen, the paste from Settings, the confirm, the steps in every state, Ready. */
const items = { accounts: true, lifeos: true, reader: true, folders: true };
const peek: SetupPeek = { giver: "Landon's MacBook", origin: "https://tempcode.landonhale.com", items, expiresAt: Date.now() + 600_000 };
const state = (steps: SetupState["steps"]): SetupState => ({ giver: peek.giver, origin: peek.origin, steps, words: ["maple", "river", "seven"], seeds: null, done: false });
const base = { onClose: () => {} };

export default [
  { name: "First screen", props: { ...base, first: true } },
  { name: "From Settings", props: { ...base } },
  { name: "Who gives what", props: { ...base, phase: { at: "confirm", link: "https://tempcode.landonhale.com/setup#v1.x.y", peek } } },
  { name: "Waiting for Allow", props: { ...base, phase: { at: "steps", state: state([
          { step: "link", state: "done" },
          { step: "allow", state: "waiting" },
          ...(["accounts", "lifeos", "work", "folders"] as const).map((step) => ({ step, state: "waiting" as const })),
        ]) } } },
  { name: "Steps not read", props: { ...base, phase: { at: "steps", readFailed: true, state: { ...state([{ step: "link", state: "done" }, { step: "allow", state: "working" }]), words: null } } } },
  {
    name: "Working, failed, folders waiting",
    props: {
      ...base,
      phase: {
        at: "steps",
        state: state([
          { step: "link", state: "done" },
          { step: "allow", state: "done" },
          { step: "accounts", state: "done" },
          { step: "lifeos", state: "failed", reason: "The installer did not finish: LifeOS-Setup.exe exited with code 1603" },
          { step: "work", state: "working" },
          { step: "folders", state: "waiting" },
        ]),
      },
    },
  },
  { name: "Ready", props: { ...base, phase: { at: "steps", state: { ...state(["link", "allow", "accounts", "lifeos", "work", "folders"].map((step) => ({ step, state: "done" })) as SetupState["steps"]), done: true } } } },
];
