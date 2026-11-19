import { useEffect, useState } from "react";
import { isLightScheme, SCHEME_CHANGE_EVENT, type ColorScheme } from "../lib/appearance";

/** The theme the window wears now, for a thing that must be told in JS (an
 *  editor's theme, a frame's document); it follows every change
 *  (lib/placeScheme.ts `changeScheme`). A colour is never picked with it:
 *  that is a token's job. */
export function useColorScheme(): ColorScheme {
  const [scheme, setScheme] = useState<ColorScheme>(() => (isLightScheme() ? "light" : "dark"));
  useEffect(() => {
    const onChange = (event: Event) => {
      const detail = (event as CustomEvent<ColorScheme>).detail;
      setScheme(detail === "light" ? "light" : "dark");
    };
    // A change between the first render and this effect is not missed.
    setScheme(isLightScheme() ? "light" : "dark");
    window.addEventListener(SCHEME_CHANGE_EVENT, onChange);
    return () => window.removeEventListener(SCHEME_CHANGE_EVENT, onChange);
  }, []);
  return scheme;
}
