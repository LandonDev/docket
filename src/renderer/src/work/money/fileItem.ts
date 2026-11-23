import type { MoneyReceived } from "@shared/contract-work-money";
import type { CanvasItem } from "@shared/work";
import { loadToast } from "../../components/ui/toaster";
import { openWorkView } from "../../lib/workSwitch";
import { request } from "./api";
import { inJob, itemName, receiptNameOf } from "./itemVerb";
import { bytesOfBase64, receiveFile } from "./receive";

/**
 * File as receipt's work: a file of the host goes by its place and the host
 * copies it; a mail's attachment is fetched to the host, read back a range
 * at a time (`work.canvas.read`) and sent as bytes, marked as from a mail.
 * Then one toast with the way to Money.
 */

/** Bytes per ranged read: the host takes at most 8 MB. */
const RANGE = 4 * 1024 * 1024;

/** A fetched item's bytes, read back whole. */
export async function itemBytes(env: string, itemId: string): Promise<Uint8Array<ArrayBuffer>> {
  const parts: string[] = [];
  let offset = 0;
  let size = Number.POSITIVE_INFINITY;
  while (offset < size) {
    const got = await request<{ data: string; size: number }>(env, "work.canvas.read", { itemId, offset, length: RANGE });
    size = got.size;
    const read = atob(got.data).length;
    if (!read) break;
    parts.push(got.data);
    offset += read;
  }
  return bytesOfBase64(parts);
}

export async function fileItem(item: CanvasItem, env: string): Promise<void> {
  const toast = await loadToast();
  const workspaceId = item.workspaceId;
  // Checked before any byte moves: a pane with no job has no ledger to file into.
  if (!workspaceId || !inJob(item)) {
    toast("Open this in a job to file it as a receipt.");
    return;
  }
  const id = toast.loading("Filing to Money…");
  try {
    const name = receiptNameOf(item) ?? itemName(item);
    if (item.source.at === "file") {
      await request<MoneyReceived>(env, "work.money.receive", { key: crypto.randomUUID(), workspaceId, name, file: item.source, source: "drop" });
    } else {
      const mail = item.source.at === "mail";
      if (mail) await request(env, "work.canvas.fetch", { itemId: item.id });
      const bytes = await itemBytes(env, item.id);
      const type = item.source.at === "mail" ? (item.source.contentType ?? "") : "";
      await receiveFile({ env, workspaceId, host: null, source: mail ? "mail" : "drop" }, new Blob([bytes], { type }), name);
    }
    toast("Filed to confirm in Money", { id, action: { label: "Open Money", onClick: () => openWorkView({ workspaceId, view: "money" }) } });
  } catch (err) {
    toast.error(err instanceof Error ? err.message : String(err), { id });
  }
}
