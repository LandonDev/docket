/** What ⌘T (Ctrl+T) or Call Hierarchy says when nothing at the caret has one. */
export function noHierarchyWords(variant: "callers" | "types"): string {
  return variant === "types" ? "No type hierarchy here" : "No call hierarchy here";
}

type MessageEditor = {
  getPosition(): { lineNumber: number; column: number } | null;
  getContribution(id: string): unknown;
};

/** The line at the caret, as Go to Definition says "No definition found":
 *  Monaco's own message widget (editor.contrib.messageController). */
export function sayAtCaret(editor: MessageEditor, message: string): void {
  const position = editor.getPosition();
  if (!position) return;
  const widget = editor.getContribution("editor.contrib.messageController") as { showMessage(message: string, position: { lineNumber: number; column: number }): void } | null;
  widget?.showMessage(message, position);
}
