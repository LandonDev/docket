// Fixtures for `bun run ui:preview src/renderer/src/work/shell/ProjectSettings.preview.tsx#WorkProjectSheetPreview`.
export default [
  { name: "A Work project: name, state, rules, accounts; nothing of code", props: {} },
  { name: "Changed, ready to save", props: { name: "Fall LAN", state: "paused", dirty: true } },
  { name: "Saving", props: { name: "Fall LAN", dirty: true, pending: true } },
  { name: "A save LifeOS refused", props: { name: "Fall LAN", dirty: true, error: "LifeOS refused the write" } },
  { name: "LifeOS on its way: the mirror's name, the state's place held", props: { reach: "loading", state: null } },
  { name: "Signed out: read-only, said once", props: { reach: "signedOut", state: null, rules: "None", accounts: false } },
  { name: "LifeOS dropped after it answered: the last state stands", props: { reach: "unreachable", state: "active" } },
  { name: "Rules kept and switched off; a host with no account to pick", props: { rules: "86 words, not sent", accounts: false } },
];
