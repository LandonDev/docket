import { Receipt } from "../../chrome/icons";
import { defineChunk } from "../../lib/lazyChunk";
import type { WorkViewDef } from "../views/registry";

/**
 * The Money row of a linked Work workspace and its view
 * (docs/agents/work-money.md): the job's ledger, a sheet in its own folder on
 * its own host, read as money. After People.
 */
export const moneyView: WorkViewDef = {
  id: "money",
  label: "Money",
  icon: Receipt,
  order: 2.75,
  fact: () => null,
  // The ledger is the Work host's file: signed out of LifeOS, he still keeps his books.
  readsLifeos: false,
  chunk: defineChunk("work-money-view", () => import("./MoneyView")),
};
