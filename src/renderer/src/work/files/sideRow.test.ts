import { describe, expect, it } from "vitest";
import type { FileEntry, FilePlace } from "@shared/work/files";
import { actsFor } from "./model";

/** Open to the Side on a row (model.ts `actsFor`): only a file on a disk can sit at a tab's side today. */
const place = { id: "folder", kind: "folder", name: "Dummy Esports", shared: false, state: { state: "ok" }, root: { at: "file", host: "h", path: "/w" }, can: [] } as unknown as FilePlace;
const entry = (ref: FileEntry["ref"], name = "Run sheet.pdf"): FileEntry => ({ key: `k:${name}`, ref, folder: null, name, kind: "pdf" });

describe("Open to the Side on a row", () => {
  it("is offered for a file on a disk, never for a LifeOS document or a Drive file, which open in a tab of their own", () => {
    const acts = (one: FileEntry) => actsFor([one], place, { tabs: true, side: true }).map((r) => r.act);
    expect(acts(entry({ at: "file", host: "h", path: "/w/Run sheet.pdf" }))).toContain("open-side");
    expect(acts(entry({ at: "lifeos", table: "docs", id: "d1" }))).not.toContain("open-side");
    expect(acts(entry({ at: "google", account: "a@b.c", fileId: "f1", mime: "application/pdf" }))).not.toContain("open-side");
  });
});
