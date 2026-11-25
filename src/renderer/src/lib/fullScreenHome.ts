/**
 * Where a popup mounts by default: the element shown full screen while there is one, else the body (undefined). The
 * browser draws nothing over a full-screen element, so a menu, popover or label portalled to the body opens unseen,
 * and a field in it takes the keys (the media player's Comment, Speed and region bar in its full screen).
 */
export function fullScreenHome(): HTMLElement | undefined {
  const el = typeof document === "undefined" ? null : document.fullscreenElement;
  return el instanceof HTMLElement ? el : undefined;
}
