/**
 * What a kind's `Bar` draws where it has nothing to show yet but the bar must keep its place (KindBar.tsx `useHeld`):
 * an empty mark, so the tools slot is not empty and the bar stays 32px (a Word file while it becomes a document: the
 * document has a bar). A module of its own, so a kind's chunk takes it without the bar's imports.
 */
export const BarHold = () => <span data-bar-hold aria-hidden className="hidden" />;
