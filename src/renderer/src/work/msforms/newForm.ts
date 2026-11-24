import type { FilePlace } from "@shared/work/files";

/**
 * What New → Form offers in a place of the Files page (docs/agents/work-msforms.md "Making a form"): our own form
 * wherever the workspace lives, and a Microsoft form only in a Teams or OneDrive library of the workspace's own
 * host, when that host has the box browser's carrier (`work.msforms.list`'s `offered`).
 */
export type FormKind = "microsoft" | "tempcode";

export function formKindsFor(place: Pick<FilePlace, "kind">, o: { sameHost: boolean; offered: boolean }): FormKind[] {
  if (!o.sameHost) return [];
  const library = place.kind === "teams" || place.kind === "onedrive";
  if (library && o.offered) return ["microsoft", "tempcode"];
  return place.kind === "folder" || library ? ["tempcode"] : [];
}

export const FORM_KIND_WORDS: Record<FormKind, { label: string; line: string }> = {
  microsoft: { label: "Microsoft Form", line: "People sign in to answer. Answers go to a workbook in this folder." },
  tempcode: { label: "TempCode Form", line: "Anyone with the link can answer. Answers go to a sheet in Work." },
};
