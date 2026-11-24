import { keepReturn, returnOf } from "./returnRecord";

type Field = "string" | "boolean" | "number";

/**
 * A view's place in a workspace as the record kept it (lib/workReturn.ts): only the fields `shape` names, of the
 * type it names. A null, a field of another type and a record from another release read as nothing, so the view
 * starts as it would have.
 */
export function keptPlace<T>(workspaceId: string, key: string, shape: { [K in keyof T]?: Field }): Partial<T> {
  const raw = returnOf(workspaceId).places?.[key];
  if (!raw || typeof raw !== "object") return {};
  const out: Record<string, unknown> = {};
  for (const [field, type] of Object.entries(shape)) {
    const value = (raw as Record<string, unknown>)[field];
    if (typeof value === type) out[field] = value;
  }
  return out as Partial<T>;
}

/** Writes a view's place; undefined drops it. */
export const keepPlace = (workspaceId: string, key: string, place: Record<string, unknown> | undefined): void => keepReturn(workspaceId, { places: { [key]: place } });
