// Runs before the bundle and before the splash paints: the class of the
// theme this window will wear, so the first paint matches it. Externalized
// (was inline in the donor's index.html) so the CSP can stay
// `script-src 'self'`.
//
// A window wears the theme of the kind of place it is on (docs/DESIGN.md
// "Appearance by place"). The kind is in the window's own address, where
// main put it (windowFrame.ts `withPlace`); else the last kind any window
// saved, which serves the web /ui and a first launch. Code is Dark until it
// is chosen, and Work follows Code until it has a choice of its own
// (lib/appearance.ts reads the same keys the same way).
(function () {
  // Copy once per origin before the splash or the bundle reads preferences.
  // Leave the old keys for older builds. The marker keeps a later reset or
  // consumed notice from restoring an old value on the next load.
  try {
    var marker = "docket.preferencesMigrated";
    var legacy = "monocode";
    if (localStorage.getItem(marker) === null) {
      var keys = Object.keys(localStorage).filter(function (key) {
        return key.startsWith(legacy + ".") || key.startsWith(legacy + ":");
      });
      keys.forEach(function (key) {
        var next = "docket" + key.slice(legacy.length);
        var value = localStorage.getItem(key);
        if (value !== null && localStorage.getItem(next) === null) localStorage.setItem(next, value);
      });
      if (keys.length) localStorage.setItem(marker, "1");
    }
  } catch (_) {}

  try {
    var root = document.documentElement;
    var known = function (value) {
      return value === "dark" || value === "light" || value === "system" ? value : null;
    };
    var kind = new URLSearchParams(window.location.search).get("place") || localStorage.getItem("docket.placeKind");
    var code = known(localStorage.getItem("docket.colorScheme"));
    var scheme = (kind === "work" && known(localStorage.getItem("docket.colorScheme.work"))) || code || "dark";
    if (scheme === "system") {
      scheme = window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
    }
    if (scheme === "light") {
      root.classList.add("theme-light");
    }
    if (typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform)) {
      root.classList.add("is-mac");
    }
  } catch (_) {}
})();
