import type { CanvasSource } from "@shared/work/canvas";
import { loadToast } from "../../components/ui/toaster";
import { openWorkView } from "../../lib/workSwitch";
import { openInFiles, withToast } from "./api";
import { writeMail } from "../mail/mailto";

/**
 * Send… on an invoice or a purchase request: nothing is sent from Money.
 * Mail's composer takes no file from outside (work-kit's MailtoDraft is
 * addresses, a subject and a body), so Send… opens the job's Mail view with
 * the composer filled, as People's Write does, and a toast names the PDF to
 * attach, with Show in Files. His Send in the composer is the only send.
 */

/** "Invoice 1042" or "Purchase request 12", from a kept file's name ("Invoice 1042 Rivera Dental.pdf"). */
export function sentAs(receipt: string): { kind: "invoice" | "request"; number: string } | null {
  const name = receipt.split(/[\\/]/).at(-1) ?? "";
  const m = /^(Invoice|Purchase request) (\S+?)(?:\s|\.pdf$)/i.exec(name);
  if (!m) return null;
  return { kind: m[1].toLowerCase() === "invoice" ? "invoice" : "request", number: m[2] };
}

/** The composer's draft: no address, the subject, and one line that claims no attachment. */
export function mailFor(kind: "invoice" | "request", number: string, total: string | null): { to: string[]; cc: string[]; bcc: string[]; subject: string; body: string } {
  const title = kind === "invoice" ? `Invoice ${number}` : `Purchase request ${number}`;
  return { to: [], cc: [], bcc: [], subject: title, body: total ? `${title}, for ${total}.` : `${title}.` };
}

/** "Attach Invoice 1042 Rivera Dental.pdf from Money/Invoices.": the file by its name and its folder under Money. */
export function attachWords(receipt: string): string {
  const parts = receipt.split(/[\\/]/).filter(Boolean);
  const name = parts.pop() ?? receipt;
  return `Attach ${name} from ${["Money", ...parts].join("/")}.`;
}

/** Send…: the job's Mail view with the composer filled, and the PDF named to attach, with Show in Files. `receipt` is the file's path under Money/. */
export function sendInvoice(env: string, workspaceId: string, file: CanvasSource, receipt: string, kind: "invoice" | "request", number: string, total: string | null): void {
  writeMail(mailFor(kind, number, total));
  openWorkView({ workspaceId, view: "mail" });
  void loadToast().then((toast) => toast(attachWords(receipt), { action: { label: "Show in Files", onClick: () => withToast(() => openInFiles(env, workspaceId, file)) } }));
}
