// Fixtures for `bun run ui:preview src/renderer/src/components/ui/time-field.tsx#TimeField`: the field with a time,
// with none, held, and the small row's size. The list of quarter hours, typing, Enter and leaving the field are
// DOM-tested (time-field.dom.test.tsx); `time-field.preview.tsx#TimeFieldOpen` draws the list in place.
const base = { "aria-label": "From", onChange: "fn", className: "w-32" };

export default [
  { name: "A time", props: { ...base, value: "18:00" } },
  { name: "Morning, on the half hour", props: { ...base, value: "06:30" } },
  { name: "No time", props: { ...base, value: "" } },
  { name: "Disabled", props: { ...base, value: "09:15", disabled: true } },
  { name: "Small", props: { ...base, value: "18:00", size: "sm" } },
];
