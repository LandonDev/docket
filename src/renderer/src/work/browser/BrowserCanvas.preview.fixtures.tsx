// Fixtures for `bun run ui:preview src/renderer/src/work/browser/BrowserCanvas.preview.tsx#BrowserPreview --width 864`.
/** A stand-in for the live window: Concur's report as the approved page draws it. Another site keeps its own colours (docs/DESIGN.md "Canvas tints"), so it is fixture data, not a token. */
const row = (y: number, a: string, b: string, bold = false) =>
  `<text x="40" y="${y}" font-size="15" ${bold ? 'font-weight="600"' : ""} fill="#1f2430">${a}</text><text x="680" y="${y}" font-size="15" text-anchor="end" ${bold ? 'font-weight="600"' : ""} fill="#1f2430">${b}</text><line x1="40" y1="${y + 14}" x2="680" y2="${y + 14}" stroke="#e3e6eb"/>`;
export const CONCUR_PAGE = `data:image/svg+xml,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 720 450" font-family="Inter,sans-serif"><rect width="720" height="450" fill="#fff"/><rect width="720" height="40" fill="#f6f7f9"/><text x="40" y="26" font-size="14" font-weight="600" fill="#1f2430">SAP Concur</text><text x="130" y="26" font-size="14" fill="#6b7280">Expense</text><text x="40" y="84" font-size="20" font-weight="600" fill="#1f2430">Columbus trip, Nov 6 to 8</text><text x="40" y="108" font-size="13" fill="#6b7280">Purdue RecWell, Esports. Policy: Staff travel</text>${row(150, "Hotel, Hilton Columbus Downtown, 2 nights", "$389.20")}${row(190, "Mileage, 412 miles", "$184.20")}${row(230, "Meals, per diem", "$39.04")}${row(270, "Report total", "$612.44", true)}<text x="470" y="336" font-size="14" fill="#1f6feb">Add Expense</text><rect x="566" y="316" width="114" height="30" rx="4" fill="#1f6feb"/><text x="623" y="336" font-size="14" text-anchor="middle" fill="#fff">Submit Report</text></svg>`,
)}`;

export default [
  { name: "The agent is driving", props: { moment: "driving" } },
  { name: "You took over", props: { moment: "took" } },
  { name: "Submit, held", props: { moment: "held" } },
  { name: "Submit, held, on a long site name", props: { moment: "held-long" } },
  { name: "Sign in needed", props: { moment: "signin" } },
  { name: "The live picture stopped", props: { moment: "stopped" } },
  { name: "Submitted", props: { moment: "done" } },
  { name: "Loading", props: { moment: "loading" } },
];
