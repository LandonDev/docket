/**
 * Imported first by the Settings fixtures: the shot page is a Mac's, so key hints made at import (lib/platform.ts
 * `IS_MAC`) say ⌘, as the owner's window does. A fixture of the box's web page still draws as a browser (no bridge).
 */
if (typeof navigator !== "undefined" && !/Mac/.test(navigator.platform)) Object.defineProperty(navigator, "platform", { value: "MacIntel", configurable: true });

export {};
