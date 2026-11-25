import ts from "typescript";
import { location, sourceFile, sourcePaths, visitSource } from "./guardSource.test-support";

// A state word must start a phrase or stand as a capitalised label. Ignore type literals,
// property keys and later pieces of a template, which don't start the displayed line.
const STATE = /^(?:Saved|Sent|Sending|Scheduled|Added|Synced|Signed in|Connected|Done|Deleted|Moved|Copied|Uploaded|Restored|All clear|Up to date|Ready|Queued|Syncing|Invites sent|Nothing held|Edits stay|Not saved)\b/;
const WHOLE_LABEL = /^[A-Z][a-z]+$/;
const WORDS = /\s/;
// A line that says where the file is in the cloud: In Teams, In OneDrive, or a template that names the service.
export const IN_CLOUD = /^`?In (?:(?:Teams|OneDrive)\b|\$\{service\})/;
// The shared words both sides say (a linked file's line in work/saveAs.ts) are state lines too.
const roots = ["src/renderer/src/work", "src/main/server/work", "src/shared/work"];

export function stateLineSources() {
  const found: { file: string; literal: string; at: string }[] = [];
  for (const file of roots.flatMap(sourcePaths)) {
    // The starter decks and sheets are example content. Mail's scenes, Google's fake and the Forms page stand-in are test data; the list is this guard's own.
    if (
      file.includes("/templates/starters/") ||
      file.endsWith("/mail/preview/scenes.ts") ||
      file.endsWith("/google/fake.ts") ||
      file.endsWith("/msforms/carrier/fakePage.ts") ||
      file.endsWith("/shared/work/stateLines.ts")
    )
      continue;
    visitSource(sourceFile(file), (node) => {
      if (node.parent && (ts.isLiteralTypeNode(node.parent) || (ts.isPropertyAssignment(node.parent) && node.parent.name === node))) return;
      const text = ts.isTemplateExpression(node) ? node.head.text : ts.isStringLiteralLike(node) || ts.isJsxText(node) ? node.text : "";
      const head = text.trim();
      const literal = ts.isTemplateExpression(node) ? node.getText()
        : ts.isJsxText(node) ? head.replace(/\s+/g, " ") : text;
      if (!IN_CLOUD.test(literal) && (!STATE.test(head) || (!WORDS.test(head) && !WHOLE_LABEL.test(head) && !WORDS.test(text.trimStart())))) return;
      found.push({ file, literal, at: location(node) });
    });
  }
  return found;
}
