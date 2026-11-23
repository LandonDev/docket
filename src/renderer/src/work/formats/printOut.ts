import { isWebMode, printPdfFile } from "../../lib/native";

/**
 * Print… from the window (docs/agents/work-editors.md "Print"): the PDF that
 * Preview drew, printed where he is. In the desktop app its bytes go to
 * main, which hands them to this computer's own PDF viewer
 * (src/main/printOut.ts: the system's print dialog is one key away there,
 * with or without a printer set up). In a browser (`/ui`) the PDF opens in
 * a tab of its own on his press, where the browser's viewer prints it.
 *
 * Every kind prints through here: hand it the previewed PDF's own bytes.
 */

export type Printed = "viewer" | "tab";

/** What he is told, and the one press it may carry. */
export type PrintSay = (words: string, action?: { label: string; run(): void }) => void;

export const PRINT_WORDS = { viewer: "Opened in your PDF viewer to print", tab: "The PDF is ready to print", open: "Open" } as const;

/** How long a browser's copy of the PDF stays, and its toast with it: long enough to find the press. */
export const TAB_MS = 10 * 60_000;
const TOAST_MS = 30_000;

const toastSay: PrintSay = (words, action) =>
  void import("../../components/ui/toaster")
    .then(({ loadToast }) => loadToast())
    .then((toast) => toast(words, action ? { duration: TOAST_MS, action: { label: action.label, onClick: action.run } } : undefined));

/**
 * Prints a PDF's bytes; rejects with the reason when this computer could not
 * open it. A browser opens a tab only on a press of his own, and the one that
 * asked for the print is long past by the time the pages are drawn and read:
 * so there it says the PDF is ready, with Open.
 */
export async function printPdf(name: string, bytes: Uint8Array, say: PrintSay = toastSay): Promise<Printed> {
  if (isWebMode()) {
    const url = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: "application/pdf" }));
    setTimeout(() => URL.revokeObjectURL(url), TAB_MS);
    say(PRINT_WORDS.tab, { label: PRINT_WORDS.open, run: () => void window.open(url, "_blank", "noopener") });
    return "tab";
  }
  const answer = await printPdfFile(name, bytes);
  if (!answer.ok) throw new Error(answer.error);
  say(PRINT_WORDS.viewer);
  return answer.via;
}
