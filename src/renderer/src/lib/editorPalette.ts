/** CodeMirror's syntax inks per theme, by the tag groups of surfaces/editorChrome.ts; each reaches
 *  4.5:1 on the pane (a comment 3:1), held by lib/tokenContrast.test.ts. Dark
 *  is pastel on the dark pane, light a One Light family darkened for white. */
export const HIGHLIGHT_INKS = {
  dark: {
    keyword: "#ff8ffd",
    callable: "#a5d5fe",
    string: "#b4fa72",
    type: "#ff8272",
    number: "#b4fa72",
    comment: "#fefdc2",
    property: "#d0d1fe",
    meta: "#8e8e8e",
    invalid: "#ffc4bd",
  },
  light: {
    keyword: "#a626a4",
    callable: "#386ee8",
    string: "#338534",
    type: "#a36800",
    number: "#986801",
    comment: "#8a9199",
    property: "#d04338",
    meta: "#5c6370",
    invalid: "#cf222e",
  },
} as const;
