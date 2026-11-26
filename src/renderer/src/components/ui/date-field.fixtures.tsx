// Fixtures for `bun run ui:preview src/renderer/src/components/ui/date-field.tsx#DateField`:
// the field with a day, with none, held, and open on its calendar (a popup a
// fixture leaves open is drawn in place). Picks, Clear and the min and max days
// are DOM-tested (date-field.dom.test.tsx).
const base = { "aria-label": "Due", onChange: "fn", className: "w-56" };

export default [
  { name: "A day", props: { ...base, value: "2026-11-26" } },
  { name: "No day", props: { ...base, value: "" } },
  { name: "Disabled", props: { ...base, value: "2026-11-26", disabled: true } },
  { name: "Open, days before the 20th held", props: { ...base, value: "2026-11-26", min: "2026-11-20", defaultOpen: true } },
];
