import type { CanvasSource } from "@shared/work/canvas";
import { openInFiles } from "./api";
import { writeMail } from "../mail/mailto";

/**
 * Send… on an invoice or a purchase request: nothing is sent from Money.
 * Mail's composer cannot take a file from outside (work-kit's MailtoDraft is
 * addresses, a subject and a body), so the composer is asked for, filled,
 * and opens the next time the Mail view shows, while the PDF opens in Files
 * for him to attach. His Send in the composer is the only send.
 */

/** "Invoice 1042" or "Purchase request 12", from a kept file's name ("Invoice 1042 Rivera Dental.pdf"). */
export function sentAs(receipt: string): { kind: "invoice" | "request"; number: string } | null {
  const name = receipt.split(/[\\/]/).at(-1) ?? "";
  const m = /^(Invoice|Purchase request) (\S+?)(?:\s|\.pdf$)/i.exec(name);
  if (!m) return null;
  return { kind: m[1].toLowerCase() === "invoice" ? "invoice" : "request", number: m[2] };
}

export function mailFor(kind: "invoice" | "request", number: string, total: string | null): { to: string[]; cc: string[]; bcc: string[]; subject: string; body: string } {
  const title = kind === "invoice" ? `Invoice ${number}` : `Purchase request ${number}`;
  return {
    to: [],
    cc: [],
    bcc: [],
    subject: title,
    body: `${title} is attached.\n${total ? `The total is ${total}.` : "Thank you."}`,
  };
}

export async function sendInvoice(env: string, workspaceId: string, file: CanvasSource, kind: "invoice" | "request", number: string, total: string | null): Promise<void> {
  writeMail(mailFor(kind, number, total));
  await openInFiles(env, workspaceId, file);
}
