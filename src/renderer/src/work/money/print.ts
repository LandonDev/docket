import type { MoneyKept } from "@shared/contract-work-money";
import type { ExportAnswer } from "@shared/contract-work-formats";
import { registry } from "../../lib/connection";
import { refusalWords } from "../../lib/settingsHome";
import { request } from "./api";
import { bytesOfBase64, partsOf } from "./receive";

/**
 * A page Money wrote (the tax summary, an invoice) printed to PDF by the
 * formats pillar on the job's host, and the bytes handed back for Money to
 * keep in the job's folder (`work.money.keep`), in parts under one key.
 */

export async function printPage(env: string, name: string, html: string): Promise<ExportAnswer> {
  try {
    return await registry.linkOf(env).request<ExportAnswer>("work.formats.print", { name, html, paper: "Letter" }, { timeoutMs: 2 * 60_000 });
  } catch (err) {
    throw new Error(refusalWords(err) || "The page was not printed");
  }
}

/** A key for one kept file: made once per Create or Export, and sent again on every retry of it, so the host files it once. */
export const newKey = (): string => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);

/** Hands a printed PDF to Money to keep; answers the last part's word (the kept file, an invoice's row). */
export async function keepPrinted(env: string, what: { workspaceId: string; what: "summary" | "invoice"; year?: number; generation?: number; invoice?: unknown }, dataBase64: string, key: string): Promise<MoneyKept> {
  const parts = await partsOf(new Blob([bytesOfBase64([dataBase64])], { type: "application/pdf" }));
  let last: MoneyKept = {};
  for (let part = 0; part < parts.length; part++) last = await request<MoneyKept>(env, "work.money.keep", { ...what, key, part, parts: parts.length, dataBase64: parts[part] });
  return last;
}
