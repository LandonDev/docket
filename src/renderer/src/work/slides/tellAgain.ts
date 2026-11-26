import { useEffect, useRef } from "react";

/**
 * Runs `tell` when `key` changes (a picked shape, the stage's size) and on every resize of the window while `key` is
 * set: Ask's anchor is a point on the screen, measured when told, so it is told again when the stage moves under it.
 */
export function useTellAgain(key: string | null, tell: () => void): void {
  const latest = useRef(tell);
  useEffect(() => {
    latest.current = tell;
  });
  useEffect(() => {
    if (key === null) return;
    const again = (): void => latest.current();
    again();
    window.addEventListener("resize", again);
    return () => window.removeEventListener("resize", again);
  }, [key]);
}
