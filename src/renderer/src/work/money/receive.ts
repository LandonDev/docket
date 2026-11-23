import { useEffect, useState } from "react";
import { MONEY_PART_BYTES, type MoneyPicture, type MoneyReceived } from "@shared/contract-work-money";
import { receiptFileName } from "@shared/work/money";
import { registry } from "../../lib/connection";
import { getPathForFile } from "../../lib/native";
import { request } from "./api";
import { loadToast } from "../../components/ui/toaster";

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
export async function receiveFile(target: ReceiveTarget, file: Blob & { name?: string }, given = file.name ?? "Receipt"): Promise<MoneyReceived> {
  // The name the host files it under, by the one rule (a picture with no extension takes its type's).
  const name = receiptFileName(given, file.type) ?? given;
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

/** A picture or a PDF, by the host's own rule (`receiptFileName`): a name Money takes, else a picture's or a PDF's type. */
export const takesFile = (file: { type: string; name: string }): boolean => receiptFileName(file.name, file.type) !== null;

/** What a batch of files leaves for Money: the ones it takes, and in words what it left out (null when nothing was left). */
export function sortFiles(files: readonly File[]): { taken: File[]; left: string | null } {
  const taken = files.filter(takesFile);
  const out = files.length - taken.length;
  if (!out) return { taken, left: null };
  if (!taken.length) return { taken, left: LEFT_WORDS };
  return { taken, left: `${LEFT_WORDS} ${out === 1 ? "1 file was" : `${out} files were`} left out.` };
}
export const LEFT_WORDS = "Money files pictures and PDFs.";

export type PictureOf = { id: string } | { workspaceId: string; receipt: string };

export type Picture = { state: "none" } | { state: "loading" } | { state: "ready"; url: string; broken: () => void } | { state: "failed"; retry: () => void };

/** A waiting receipt's picture, or a filed row's, as a URL: loading, ready, or failed with a way to ask again. The URL goes with the component. */
export function usePicture(env: string, of: PictureOf | null): Picture {
  const [picture, setPicture] = useState<Picture>(of ? { state: "loading" } : { state: "none" });
  const [attempt, setAttempt] = useState(0);
  const key = of ? ("id" in of ? `id:${of.id}` : `r:${of.workspaceId}:${of.receipt}`) : "";
  useEffect(() => {
    if (!of) {
      setPicture({ state: "none" });
      return;
    }
    let live = true;
    let made: string | null = null;
    const failed = (): Picture => ({ state: "failed", retry: () => setAttempt((n) => n + 1) });
    setPicture({ state: "loading" });
    const ask = (part: number) => request<MoneyPicture>(env, "work.money.picture", { ...of, part });
    void (async () => {
      const first = await ask(0);
      const rest = await Promise.all(Array.from({ length: Math.max(0, first.parts - 1) }, (_, i) => ask(i + 1)));
      if (!live) return;
      made = URL.createObjectURL(new Blob([bytesOfBase64([first, ...rest].map((p) => p.dataBase64))], { type: first.mime }));
      // The bytes came, but the browser may still not draw them: the image's error comes back to the failed state.
      setPicture({ state: "ready", url: made, broken: () => live && setPicture(failed()) });
    })().catch(() => live && setPicture(failed()));
    return () => {
      live = false;
      if (made) URL.revokeObjectURL(made);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [env, key, attempt]);
  return picture;
}

/** "Filing 2 receipts…" from the moment files are taken until the host has them all: dismissed when they reach To confirm, or settled to the refusal. */
export async function filingToast<T>(count: number, run: () => Promise<T>, refusedOf: (result: T) => string[]): Promise<T> {
  const toast = await loadToast();
  const id = toast.loading(count === 1 ? "Filing a receipt…" : `Filing ${count} receipts…`);
  try {
    const result = await run();
    const refused = refusedOf(result);
    if (refused.length) toast.error(refused.join("\n"), { id });
    else toast.dismiss(id);
    return result;
  } catch (err) {
    toast.error(err instanceof Error ? err.message : String(err), { id });
    throw err;
  }
}
