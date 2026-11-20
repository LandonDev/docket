import {
  HighlightStyle,
  LanguageSupport,
  codeFolding,
  foldGutter,
  syntaxHighlighting,
} from "@codemirror/language";
import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { cspStyleNonce } from "../lib/csp";
import { basename } from "../lib/fs";
import type { ColorScheme } from "../lib/appearance";
import { HIGHLIGHT_INKS } from "../lib/editorPalette";

function editorThemeStyles(dark: boolean) {
  return EditorView.theme(
  {
    "&": {
      height: "100%",
      backgroundColor: "transparent",
      color: "var(--foreground)",
      // Settings → Appearance sets it on <html>; CodeMirror follows live.
      fontSize: "var(--font-size-code, 13px)",
      userSelect: "text",
    },
    "&.cm-focused": {
      outline: "none",
    },
    ".cm-scroller": {
      overflow: "auto",
      overscrollBehavior: "none",
      fontFamily: "var(--font-mono)",
      lineHeight: "1.6",
    },
    ".cm-content": {
      minHeight: "100%",
      padding: "8px 0 32px",
      caretColor: "var(--foreground)",
    },
    ".cm-line": {
      padding: "0 12px 0 6px",
    },
    ".cm-gutters": {
      backgroundColor: "transparent",
      color: "var(--ink-38)",
      borderRight:
        "1px solid color-mix(in srgb, var(--foreground) 7%, transparent)",
      paddingLeft: "4px",
    },
    ".cm-lineNumbers .cm-gutterElement": {
      minWidth: "36px",
      padding: "0 8px 0 4px",
    },
    ".cm-foldGutter": {
      width: "12px",
    },
    ".cm-foldGutter .cm-gutterElement": {
      padding: "0 2px",
      cursor: "pointer",
      color: "var(--ink-45)",
    },
    ".cm-foldPlaceholder": {
      color: "var(--ink-40)",
    },
    ".cm-activeLine": {
      backgroundColor: "color-mix(in srgb, var(--foreground) 10%, transparent)",
    },
    ".cm-activeLineGutter": {
      backgroundColor: "color-mix(in srgb, var(--foreground) 10%, transparent)",
      color: "var(--soft-foreground)",
    },
    ".cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection":
      {
        backgroundColor:
          "color-mix(in srgb, var(--color-accent) 35%, transparent) !important",
      },
    ".cm-cursor, .cm-dropCursor": {
      borderLeftColor: "var(--foreground)",
    },
    ".cm-matchingBracket": {
      backgroundColor:
        "color-mix(in srgb, var(--foreground) 14%, transparent)",
      outline:
        "1px solid color-mix(in srgb, var(--foreground) 28%, transparent)",
    },
    ".cm-nonmatchingBracket": {
      backgroundColor: "color-mix(in srgb, var(--destructive) 32%, transparent)",
      outline: "1px solid color-mix(in srgb, var(--destructive) 55%, transparent)",
    },
    ".cm-panels": {
      backgroundColor: "var(--background)",
      color: "var(--foreground)",
      borderColor: "color-mix(in srgb, var(--foreground) 10%, transparent)",
    },
    // A floating layer like every popover: the popover fill, the hairline,
    // the 12px radius and the overlay shadow.
    ".cm-tooltip": {
      backgroundColor: "var(--popover)",
      color: "var(--foreground)",
      border: "1px solid var(--border)",
      borderRadius: "var(--radius-xl)",
      boxShadow: "var(--shadow-overlay)",
      overflow: "hidden",
    },
    ".cm-tooltip.cm-tooltip-autocomplete": {
      backgroundColor: "var(--popover)",
    },
    ".cm-tooltip-autocomplete > ul": {
      fontFamily: "var(--font-mono)",
      fontSize: "12px",
      maxHeight: "240px",
    },
    ".cm-tooltip-autocomplete > ul > li": {
      padding: "2px 8px",
    },
    // The highlighted row is a muted fill, as in every menu.
    ".cm-tooltip-autocomplete > ul > li[aria-selected]": {
      backgroundColor: "var(--muted)",
      color: "var(--foreground)",
    },
    ".cm-completionDetail": {
      color: "var(--ink-50)",
      fontStyle: "normal",
      marginLeft: "8px",
    },
  }, { dark });
}

/**
 * The theme, plus whatever CSP nonce its style sheet needs. CodeMirror mounts
 * every rule it owns — base theme included — through style-mod at runtime, so a
 * style-src that rejects inline sheets leaves the editor completely unstyled.
 * See `cspStyleNonce` for why this is currently a no-op.
 */
/** A fold gutter marker: CodeMirror's glyphs without its native `title`
 *  ("Fold line"), which no label on hover in the app ever is. */
export function foldMarkerDOM(open: boolean): HTMLElement {
  const span = document.createElement("span");
  span.textContent = open ? "⌄" : "›";
  return span;
}

/** The folded range's placeholder: CodeMirror's, named for screen readers, without its `title`. */
export function foldPlaceholderDOM(_view: EditorView, onclick: (event: Event) => void): HTMLElement {
  const span = document.createElement("span");
  span.className = "cm-foldPlaceholder";
  span.textContent = "…";
  span.setAttribute("aria-label", "folded code");
  span.onclick = onclick;
  return span;
}

/** Code folding with the gutter, both drawn by the two builders above. */
export const editorFolding: Extension = [
  codeFolding({ placeholderDOM: foldPlaceholderDOM }),
  foldGutter({ markerDOM: foldMarkerDOM }),
];

export function editorThemeFor(scheme: ColorScheme): Extension {
  return [
    editorThemeStyles(scheme === "dark"),
    EditorView.cspNonce.of(cspStyleNonce()),
  ];
}

const HIGHLIGHT_TAGS = {
  keyword: [
    tags.keyword,
    tags.controlKeyword,
    tags.definitionKeyword,
    tags.moduleKeyword,
    tags.operatorKeyword,
    tags.modifier,
    tags.self,
    tags.bool,
    tags.null,
    tags.atom,
    tags.unit,
  ],
  callable: [
    tags.function(tags.variableName),
    tags.function(tags.propertyName),
    tags.labelName,
    tags.macroName,
  ],
  string: [
    tags.string,
    tags.docString,
    tags.character,
    tags.attributeValue,
    tags.special(tags.string),
    tags.regexp,
    tags.escape,
  ],
  type: [
    tags.typeName,
    tags.className,
    tags.namespace,
    tags.tagName,
    tags.standard(tags.typeName),
  ],
  number: [tags.number, tags.integer, tags.float],
  comment: [tags.comment, tags.lineComment, tags.blockComment, tags.docComment],
  property: [tags.propertyName, tags.attributeName],
  meta: [tags.meta, tags.processingInstruction, tags.annotation],
  heading: [
    tags.heading,
    tags.heading1,
    tags.heading2,
    tags.heading3,
    tags.heading4,
    tags.heading5,
    tags.heading6,
  ],
};

const highlightStyle = (inks: (typeof HIGHLIGHT_INKS)[ColorScheme]) =>
  HighlightStyle.define([
    { tag: HIGHLIGHT_TAGS.keyword, color: inks.keyword },
    { tag: HIGHLIGHT_TAGS.heading, color: "var(--color-markdown-heading)" },
    { tag: HIGHLIGHT_TAGS.callable, color: inks.callable },
    { tag: HIGHLIGHT_TAGS.string, color: inks.string },
    { tag: HIGHLIGHT_TAGS.type, color: inks.type },
    { tag: HIGHLIGHT_TAGS.number, color: inks.number },
    { tag: HIGHLIGHT_TAGS.comment, color: inks.comment },
    { tag: HIGHLIGHT_TAGS.property, color: inks.property },
    { tag: HIGHLIGHT_TAGS.meta, color: inks.meta },
    { tag: tags.invalid, color: inks.invalid, textDecoration: "underline" },
  ]);

const HIGHLIGHT_DARK = highlightStyle(HIGHLIGHT_INKS.dark);
const HIGHLIGHT_LIGHT = highlightStyle(HIGHLIGHT_INKS.light);

export function editorHighlightStyleFor(scheme: ColorScheme) {
  return scheme === "light" ? HIGHLIGHT_LIGHT : HIGHLIGHT_DARK;
}

/** Theme + syntax highlighting for one color scheme; swap via a Compartment. */
export function schemeExtensions(scheme: ColorScheme): Extension[] {
  return [
    editorThemeFor(scheme),
    syntaxHighlighting(editorHighlightStyleFor(scheme)),
  ];
}

export async function languageForPath(path: string): Promise<Extension | null> {
  const name = basename(path).toLowerCase();
  const extension = name.includes(".") ? name.slice(name.lastIndexOf(".")) : "";

  if ([".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx"].includes(extension)) {
    const { javascript } = await import("@codemirror/lang-javascript");
    return javascript({
      jsx: extension === ".jsx" || extension === ".tsx",
      typescript: extension === ".ts" || extension === ".tsx",
    });
  }
  if (extension === ".json" || name === "package-lock.json") {
    const { json } = await import("@codemirror/lang-json");
    return json();
  }
  if (extension === ".css") {
    const { css } = await import("@codemirror/lang-css");
    return css();
  }
  if ([".html", ".htm"].includes(extension)) {
    const { html } = await import("@codemirror/lang-html");
    return html();
  }
  if ([".md", ".mdx", ".markdown"].includes(extension)) {
    const { markdown } = await import("@codemirror/lang-markdown");
    return markdown();
  }
  if (extension === ".rs") {
    const { rustLanguage } = await import("@codemirror/lang-rust");
    const { completeFromList } = await import("@codemirror/autocomplete");
    const keywords =
      "as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while"
        .split(" ")
        .map((label) => ({ label, type: "keyword" }));
    return new LanguageSupport(rustLanguage, [
      rustLanguage.data.of({ autocomplete: completeFromList(keywords) }),
    ]);
  }
  if (extension === ".py") {
    const { python } = await import("@codemirror/lang-python");
    return python();
  }
  return null;
}
