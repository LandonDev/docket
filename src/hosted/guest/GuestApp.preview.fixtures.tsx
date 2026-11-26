// Fixtures for `bun run ui:preview src/hosted/guest/GuestApp.preview.tsx#GuestPagePreview --width 864`.
const wait = async (until: () => boolean): Promise<void> => {
  for (let i = 0; i < 80 && !until(); i++) await new Promise((done) => setTimeout(done, 50));
};
const text = (root: HTMLElement, words: string): boolean => (root.textContent ?? "").includes(words);

export default [
  { name: "A project's link: the line and its screens", props: { moment: "project" }, prepare: (root: HTMLElement) => wait(() => text(root, "Book the ballroom")) },
  {
    name: "A project's document that did not open",
    props: { moment: "child-failed" },
    prepare: async (root: HTMLElement) => {
      await wait(() => text(root, "Run of show"));
      const row = [...root.querySelectorAll<HTMLElement>("button, [role=button], a")].find((el) => el.textContent?.includes("Run of show"));
      row?.click();
      await wait(() => text(root, "Couldn't open this document"));
    },
  },
  { name: "An Edit link's document, waiting for its socket", props: { moment: "doc" }, prepare: (root: HTMLElement) => wait(() => !root.querySelector("main [aria-busy=true]")) },
  { name: "An Edit link's sheet, waiting for its socket", props: { moment: "sheet" }, prepare: (root: HTMLElement) => wait(() => !root.querySelector("main [aria-busy=true]")) },
];
