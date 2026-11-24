import { useCallback, useEffect, useRef, useState } from "react";
import type { EntryFields, MoneyActed, MoneyBooks, MoneyRead, MoneyState, MoneyTripped } from "@shared/contract-work-money";
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
  /** the read of the period asked for; null until that period answers (never another period's) */
  read: MoneyRead | null;
  /** the last read of this period failed, in the host's words */
  error: string | null;
  /** a read is on its way */
  loading: boolean;
}

const periodKey = (p: Period): string => `${p.from}|${p.to}`;

/**
 * The view's read for a period, asked again when the period changes, when
 * the window comes forward, on the `work.money` push and after each act of
 * his (`reload`). Only the newest answer is shown, and a read belongs to its
 * period: under a new period's label nothing of the old one is shown, and a
 * failed read keeps only the same period's last answer.
 */
export function useMoney(env: string, workspaceId: string, period: Period): [MoneyLoad, () => Promise<void>] {
  const key = periodKey(period);
  const [state, setState] = useState<{ key: string; read: MoneyRead | null; error: string | null; loading: boolean }>({ key, read: null, error: null, loading: true });
  const asked = useRef(0);
  const { from, to } = period;
  const fetch = useCallback(() => {
    const mine = ++asked.current;
    const of = `${from}|${to}`;
    setState((s) => (s.key === of ? (s.loading ? s : { ...s, loading: true }) : { key: of, read: null, error: null, loading: true }));
    return registry
      .linkOf(env)
      .request<MoneyRead>("work.money.read", { workspaceId, from, to })
      .then(
        (read) => {
          if (mine === asked.current) setState({ key: of, read, error: null, loading: false });
        },
        (err: unknown) => {
          if (mine === asked.current) setState((s) => ({ key: of, read: s.key === of ? s.read : null, error: refusalWords(err) || "The host did not answer", loading: false }));
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
  // Until the new period's own answer lands, the view has nothing of it to show.
  const load: MoneyLoad = state.key === key ? { read: state.read, error: state.error, loading: state.loading } : { read: null, error: null, loading: true };
  return [load, fetch];
}

/** A row as the window saw it, for a write that names it. */
export const atOf = (row: { ref: string | null; row: number; sig: string }): RowAt => ({ ref: row.ref, row: row.row, sig: row.sig });

/** Says the ledger changed under him; the caller reads again. */
export function sayChanged(): void {
  void loadToast().then((toast) => toast(CHANGED_WORDS));
}

export const SUGGESTED_WORDS = "Suggested in the ledger. Accept it there.";

/**
 * What a write's answer says to him: the ledger changed under him (nothing was written; read again), or on a
 * ledger others can open the write waits as a suggestion, which he accepts in the sheet. Answers false when
 * nothing was written.
 */
export function heard(env: string, workspaceId: string, acted: MoneyActed | null | undefined, words: string = SUGGESTED_WORDS): boolean {
  if (!acted) return true;
  if ("changed" in acted) {
    sayChanged();
    return false;
  }
  if (acted.suggested) saySuggested(env, workspaceId, words);
  return true;
}

/** The one toast for a write that waits as a suggestion, with the way to accept it. */
export function saySuggested(env: string, workspaceId: string, words: string = SUGGESTED_WORDS, book: "ledger" | "mileage" = "ledger"): void {
  void loadToast().then((toast) => toast(words, { action: { label: book === "ledger" ? "Open ledger" : "Open mileage log", onClick: () => withToast(() => openBook(env, workspaceId, book)) } }));
}

/** A trip's answer: its pay row in the ledger and its row in the mileage log; one toast when either only waits as a suggestion. */
export function heardTrip(env: string, workspaceId: string, tripped: MoneyTripped | null | undefined): void {
  heardTrips(env, workspaceId, [tripped]);
}

/** Several trips' answers (Add all), said once: the ledger changed, or one suggestion toast, the ledger winning over the mileage log. */
export function heardTrips(env: string, workspaceId: string, answers: readonly (MoneyTripped | null | undefined)[]): void {
  let changed = false;
  let ledger = false;
  let mileage = false;
  for (const t of answers) {
    // Skipped meanwhile: nothing was written, so nothing is said.
    if (!t || t.skipped) continue;
    if (t.pay && "changed" in t.pay) changed = true;
    else if (t.pay?.suggested) ledger = true;
    if (t.trip?.suggested) mileage = true;
  }
  if (changed) return sayChanged();
  if (ledger || mileage) saySuggested(env, workspaceId, SUGGESTED_WORDS, ledger ? "ledger" : "mileage");
}

/** Adds a row (under the dialog's `key`, so a Save sent again after a lost answer adds nothing twice), or with `at` changes that one. True when it was written (or suggested); false when the ledger changed (the toast is said). */
export async function saveEntry(env: string, workspaceId: string, fields: EntryFields, at?: RowAt, key?: string): Promise<boolean> {
  return heard(env, workspaceId, await request<MoneyActed>(env, "work.money.entry", { workspaceId, ...(at ? { at } : {}), fields, ...(!at && key ? { key } : {}) }));
}

/** An open row is paid, or paid back, today. */
export async function markPaid(env: string, workspaceId: string, at: RowAt): Promise<boolean> {
  return heard(env, workspaceId, await request<MoneyActed>(env, "work.money.paid", { workspaceId, at }));
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

export const MILEAGE_OUTSIDE_WORDS = "The mileage log leads outside this job's folder.";

/** Open ledger, Open mileage log. The ledger opens whatever state the mileage log is in; a log that leads out of the job opens nothing and says so. */
export async function openBook(env: string, workspaceId: string, which: "ledger" | "mileage"): Promise<void> {
  const books = await openBooks(env, workspaceId);
  const file = books[which];
  if (!file) throw new Error(MILEAGE_OUTSIDE_WORDS);
  await openInFiles(env, workspaceId, file, which === "ledger" ? "Ledger" : "Mileage");
}

/** A row's kept receipt, opened in Files. */
export const openReceipt = (env: string, workspaceId: string, read: MoneyRead, receipt: string): Promise<void> => openInFiles(env, workspaceId, receiptSource(read.root, receipt));

/** Runs a press and says a refusal as a toast. */
export function withToast(run: () => Promise<unknown>): void {
  run().catch((err: unknown) => void loadToast().then((toast) => toast.error(refusalWords(err) || "The host did not answer")));
}

/** A call on the workspace's host, with the host's refusal in its own words. */
export async function request<T>(env: string, method: string, params: object, o?: { timeoutMs?: number }): Promise<T> {
  try {
    return await registry.linkOf(env).request<T>(method, params, o);
  } catch (err) {
    throw new Error(refusalWords(err) || "The host did not answer");
  }
}
