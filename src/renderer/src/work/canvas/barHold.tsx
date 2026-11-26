import { createContext, useContext, useLayoutEffect } from "react";

/**
 * What a kind's `Bar` draws where it has nothing to show yet but the bar must keep its place (KindBar.tsx `useHeld`):
 * an empty mark, so the tools slot is not empty and the bar stays 32px (a Word file while it becomes a document: the
 * document has a bar). A module of its own, so a kind's chunk takes it without the bar's imports.
 */
export const BarHold = () => <span data-bar-hold aria-hidden className="hidden" />;

/** Set by the pane (CanvasPane.tsx): how a body in the item's place tells the bar the item is shut. */
export const BarShut = createContext<((shut: boolean) => void) | null>(null);

/**
 * Said by what stands in the body's place while the item cannot open until he acts: the centred failure (`OpenFailed`)
 * and a PDF's password ask. While it shows, the bar's hold lets go, so a kind whose `Bar` drew its bone first leaves no
 * empty 32px row over it; the bar is drawn only for what it still holds. Gone (Retry, the password taken), the kind's
 * bone holds the bar again.
 */
export function useShutsBar(): void {
  const shut = useContext(BarShut);
  useLayoutEffect(() => {
    if (!shut) return;
    shut(true);
    return () => shut(false);
  }, [shut]);
}
