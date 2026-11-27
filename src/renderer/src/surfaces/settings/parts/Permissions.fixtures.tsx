// bun run ui:preview src/renderer/src/surfaces/settings/parts/Permissions.tsx#Permissions --shot --fresh
// The two macOS grants while they are read (each row's word drawn as bones) beside the same rows known.
const without = { accessibility: "Agents cannot click or type in apps.", screen: "Agents cannot see the screen." };

export default [
  { name: "grants not yet known: each word drawn as bones", props: { accessibility: null, screen: null, without } },
  { name: "known: one granted, one missing", props: { accessibility: true, screen: false, without } },
];
