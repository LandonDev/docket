// Fixtures for `bun run ui:preview src/renderer/src/work/sheets/preview.preview.tsx#SheetPreview --width 864`.
export default [
  { name: "Excel: an opened workbook, Save a copy, the format as a menu", props: { moment: "excel" } },
  { name: "PDF of a long sheet: the first pages, more follow", props: { moment: "long" } },
  { name: "Excel 97-2003: what it drops", props: { moment: "xls" } },
  { name: "CSV: one sheet's values, the sheet picker", props: { moment: "csv" } },
];
