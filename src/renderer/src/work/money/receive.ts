import { useEffect, useState } from "react";
import { MONEY_PART_BYTES, type MoneyPicture, type MoneyReceived } from "@shared/contract-work-money";
import { registry } from "../../lib/connection";
import { getPathForFile } from "../../lib/native";
import { request } from "./api";

/**
 * Receipts into To confirm (`work.money.receive`): a file of the window's own
 * host goes by its path and the host copies it; any other goes as bytes, in
 * parts of at most MONEY_PART_BYTES, every part and a retry under one key.
 * And the way back: a waiting receipt's picture, a part at a time, as a URL
 * the window can show.
 */

/** A receipt's bytes as base64, a part at a time. */
export async function partsOf(blob: Blob): Promise<string[]> {
  const parts: string[] = [];
  for (let at = 0; at < Math.max(blob.size, 1); at += MONEY_PART_BYTES) parts.push(base64Of(await bytesOf(blob.slice(at, at + MONEY_PART_BYTES))));
  return parts;
}

async function bytesOf(blob: Blob): Promise<Uint8Array> {
  if (typeof blob.arrayBuffer === "function") return new Uint8Array(await blob.arrayBuffer());
  return new Promise((done, fail) => {
    const reader = new FileReader();
    reader.onload = () => done(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => fail(reader.error);
    reader.readAsArrayBuffer(blob);
  });
}

export function base64Of(bytes: Uint8Array): string {
  let text = "";
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
}

export function bytesOfBase64(parts: readonly string[]): Uint8Array<ArrayBuffer> {
  const chunks = parts.map((p) => Uint8Array.from(atob(p), (c) => c.charCodeAt(0)));
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

function pathOf(file: File): string | undefined {
  try {
    return getPathForFile(file).trim() || undefined;
  } catch {
    return undefined;
  }
}

/** The window runs on that host, so a dropped file's path means something there. */
function onHost(env: string): boolean {
  try {
    return registry.primary().environmentId === env;
  } catch {
    return false;
  }
}

const newKey = (): string => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);

export interface ReceiveTarget {
  env: string;
  workspaceId: string;
  /** the job's host as Money names it (`MoneyRead.root.host`): a path is sent only when the window is on that host */
  host: string | null;
  source?: "drop" | "mail";
}

/** One receipt into To confirm; answers the host's last word on it. */
export async function receiveFile(target: ReceiveTarget, file: Blob & { name?: string }, name = file.name ?? "Receipt"): Promise<MoneyReceived> {
  const base = { key: newKey(), workspaceId: target.workspaceId, name, ...(file.type ? { mime: file.type } : {}), source: target.source ?? "drop" };
  const path = typeof File !== "undefined" && file instanceof File && target.host && onHost(target.env) ? pathOf(file) : undefined;
  if (path) return request<MoneyReceived>(target.env, "work.money.receive", { ...base, file: { at: "file", host: target.host, path } });
  const parts = await partsOf(file);
  let last: MoneyReceived | null = null;
  for (let part = 0; part < parts.length; part++) last = await request<MoneyReceived>(target.env, "work.money.receive", { ...base, part, parts: parts.length, dataBase64: parts[part] });
  return last!;
}

/** Every file in turn; a refusal of one does not stop the rest. Answers the refusals, in the host's words. */
export async function receiveFiles(target: ReceiveTarget, files: readonly File[]): Promise<string[]> {
  const refused: string[] = [];
  for (const file of files) {
    try {
      await receiveFile(target, file);
    } catch (err) {
      refused.push(`${file.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return refused;
}

/** A picture or a PDF: what Money takes. */
export const takesFile = (file: { type: string; name: string }): boolean => /^image\//.test(file.type) || file.type === "application/pdf" || /\.(pdf|jpe?g|png|heic|webp|gif)$/i.test(file.name);

export type PictureOf = { id: string } | { workspaceId: string; receipt: string };

/** A waiting receipt's picture, or a filed row's, as a URL; null while it comes or when there is none. The URL goes with the component. */
export function usePicture(env: string, of: PictureOf | null): string | null {
  const [url, setUrl] = useState<string | null>(null);
  const key = of ? ("id" in of ? `id:${of.id}` : `r:${of.workspaceId}:${of.receipt}`) : "";
  useEffect(() => {
    if (!of) return;
    let live = true;
    let made: string | null = null;
    const ask = (part: number) => request<MoneyPicture>(env, "work.money.picture", { ...of, part });
    void (async () => {
      const first = await ask(0);
      const rest = await Promise.all(Array.from({ length: Math.max(0, first.parts - 1) }, (_, i) => ask(i + 1)));
      if (!live) return;
      made = URL.createObjectURL(new Blob([bytesOfBase64([first, ...rest].map((p) => p.dataBase64))], { type: first.mime }));
      setUrl(made);
    })().catch(() => live && setUrl(null));
    return () => {
      live = false;
      if (made) URL.revokeObjectURL(made);
      setUrl(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [env, key]);
  return url;
}
