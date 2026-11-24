/** Set up a computer's states for ui:preview: the form, the form with LifeOS signed out and no Work workspace, and the link made. */
const base = { onClose: () => {} };

export default [
  { name: "Form", props: { ...base, lifeosSignedIn: true, workspaces: [{ id: "w1", name: "Purdue" }, { id: "w2", name: "Hypixel" }] } },
  { name: "LifeOS signed out, no Work workspace", props: { ...base, lifeosSignedIn: false, workspaces: [] } },
  {
    name: "Link made",
    props: {
      ...base,
      lifeosSignedIn: true,
      workspaces: [],
      made: { link: "https://tempcode.landonhale.com/setup#v1.ABCDE-FGHIJ.q2Vb9xYwT0aL3mKpRz8nHc4dEfGh1JkL5oPqRsTuVw", expiresAt: Date.now() + 14 * 60_000 + 32_000, pairingId: "p1" },
    },
  },
];
