import { useCallback, useEffect, useRef, useState } from "react";
import type { EntryFields, MoneyActed, MoneyBooks, MoneyRead, MoneyState } from "@shared/contract-work-money";
import { receiptSource } from "@shared/contract-work-money";
import type { CanvasSource } from "@shared/work/canvas";
import type { Period, RowAt } from "@shared/work/money";
import { registry } from "../../lib/connection";
import { refusalWords } from "../../lib/settingsHome";
import { openWorkView } from "../../lib/workSwitch";
import { loadToast } from "../../components/ui/toaster";

/**
 * Money's calls to the workspace's host (src/shared/contract-work-money.ts)
 * and the one loader the view paints from. Every write answers what it wrote
 * or that the row it named has changed; on the second the window says so and
 * reads again.
 */

export const CHANGED_WORDS = "The ledger changed. Showing it as it is now.";

export interface MoneyLoad {
  /** the last read that landed; kept under a failed read */
  read: MoneyRead | null;
  /** the last read failed, in the host's words */
  error: string | null;
  /** a read is on its way */
  loading: boolean;
}

/**
 * The view's read for a period, asked again when the period changes, when
 * the window comes forward, on the `work.money` push and after each act of
 * his (`reload`). Only the newest answer is shown.
 */
export function useMoney(env: string, workspaceId: string, period: Period): [MoneyLoad, () => Promise<void>] {
  const [state, setState] = useState<MoneyLoad>({ read: null, error: null, loading: true });
  const asked = useRef(0);
  const { from, to } = period;
  const fetch = useCallback(() => {
    const mine = ++asked.current;
    setState((s) => (s.loading ? s : { ...s, loading: true }));
    return registry
      .linkOf(env)
      .request<MoneyRead>("work.money.read", { workspaceId, from, to })
      .then(
        (read) => {
          if (mine === asked.current) setState({ read, error: null, loading: false });
        },
        (err: unknown) => {
          if (mine === asked.current) setState((s) => ({ read: s.read, error: refusalWords(err) || "The host did not answer", loading: false }));
        },
      );
  }, [env, workspaceId, from, to]);
  useEffect(() => {
    void fetch();
    const again = () => void fetch();
    window.addEventListener("focus", again);
    const off = registry.linkOf(env).onPush((push) => {
      if (push.push === "work.money" && push.workspaceId === workspaceId) again();
    });
    return () => {
      // A late answer of this period never paints over the next one's.
      asked.current++;
      window.removeEventListener("focus", again);
      off();
    };
  }, [env, workspaceId, fetch]);
  return [state, fetch];
}

/** A row as the window saw it, for a write that names it. */
export const atOf = (row: { ref: string | null; row: number; sig: string }): RowAt => ({ ref: row.ref, row: row.row, sig: row.sig });

/** Says the ledger changed under him; the caller reads again. */
export function sayChanged(): void {
  void loadToast().then((toast) => toast(CHANGED_WORDS));
}

/** Adds a row, or with `at` changes that one. True when it was written; false when the ledger changed (the toast is said). */
export async function saveEntry(env: string, workspaceId: string, fields: EntryFields, at?: RowAt): Promise<boolean> {
  const acted = await request<MoneyActed>(env, "work.money.entry", { workspaceId, ...(at ? { at } : {}), fields });
  if ("changed" in acted) {
    sayChanged();
    return false;
  }
  return true;
}

/** An open row is paid, or paid back, today. */
export async function markPaid(env: string, workspaceId: string, at: RowAt): Promise<boolean> {
  const acted = await request<MoneyActed>(env, "work.money.paid", { workspaceId, at });
  if ("changed" in acted) {
    sayChanged();
    return false;
  }
  return true;
}

export const moneyState = (env: string): Promise<MoneyState> => request<MoneyState>(env, "work.money.state", {});

/** The ledger's and the mileage log's files, made when missing; `restore` writes back the headers the ledger lacks. */
export const openBooks = (env: string, workspaceId: string, restore?: boolean): Promise<MoneyBooks> =>
  request<MoneyBooks>(env, "work.money.open", { workspaceId, ...(restore ? { restore: true } : {}) });

/** A file of the job's host in a tab of Files, which the window then shows. */
export async function openInFiles(env: string, workspaceId: string, ref: CanvasSource, name?: string): Promise<void> {
  await request(env, "work.files.open", { workspaceId, ref, ...(name ? { name } : {}) });
  openWorkView({ workspaceId, view: "files" });
}

/** Open ledger, Open mileage log. */
export async function openBook(env: string, workspaceId: string, which: "ledger" | "mileage"): Promise<void> {
  const books = await openBooks(env, workspaceId);
  await openInFiles(env, workspaceId, books[which], which === "ledger" ? "Ledger" : "Mileage");
}

/** A row's kept receipt, opened in Files. */
export const openReceipt = (env: string, workspaceId: string, read: MoneyRead, receipt: string): Promise<void> => openInFiles(env, workspaceId, receiptSource(read.root, receipt));

/** Runs a press and says a refusal as a toast. */
export function withToast(run: () => Promise<unknown>): void {
  run().catch((err: unknown) => void loadToast().then((toast) => toast.error(refusalWords(err) || "The host did not answer")));
}

/** A call on the workspace's host, with the host's refusal in its own words. */
export async function request<T>(env: string, method: string, params: object): Promise<T> {
  try {
    return await registry.linkOf(env).request<T>(method, params);
  } catch (err) {
    throw new Error(refusalWords(err) || "The host did not answer");
  }
}
