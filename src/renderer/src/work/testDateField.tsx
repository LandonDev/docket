import type { ComponentProps } from "react";

/**
 * Tests: the shared DateField (components/ui/date-field.tsx) as a date input with the same value contract, so a
 * dialog's own rules are read and set by its value ("2026-11-26", "" for none) while the field's calendar is proven
 * by its own tests and `dateField.dom.test.tsx`. Mocked in with
 * `vi.mock("…/components/ui/date-field", async () => ({ DateField: (await import("…/work/testDateField")).DateFieldStandIn }))`.
 */
export function DateFieldStandIn({
  value,
  onChange,
  required: _required,
  placeholder: _placeholder,
  defaultOpen: _open,
  ...props
}: Omit<ComponentProps<"input">, "value" | "onChange"> & { value: string; onChange(value: string): void; defaultOpen?: boolean }) {
  return <input type="date" value={value} onChange={(e) => onChange(e.target.value)} {...props} />;
}
