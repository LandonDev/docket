/** The New event form's fields, and the calendar act's payload they make. Pure, for its tests. */
export type EventForm = { title: string; day: string; from: string; to: string; where: string; invite: string };

export const pad = (n: number) => String(n).padStart(2, "0");

const ADDRESS = /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/;

/** `calendarOps.save`'s payload for a create, or the words that say what is wrong. */
export function eventPayload(form: EventForm): string | { title: string; startsAt: number; endsAt: number; location?: string; attendees?: { address: string }[] } {
  const title = form.title.trim();
  if (!title) return "Give it a name";
  const startsAt = new Date(`${form.day}T${form.from}`).getTime();
  const endsAt = new Date(`${form.day}T${form.to}`).getTime();
  if (!Number.isFinite(startsAt) || !Number.isFinite(endsAt)) return "Pick a day and its times";
  if (endsAt <= startsAt) return "It must end after it starts";
  const addresses = form.invite.split(/[,;\s]+/).map((a) => a.trim().toLowerCase()).filter(Boolean);
  const wrong = addresses.find((a) => !ADDRESS.test(a));
  if (wrong) return `${wrong} is not an address`;
  return {
    title,
    startsAt,
    endsAt,
    ...(form.where.trim() ? { location: form.where.trim() } : {}),
    ...(addresses.length ? { attendees: [...new Set(addresses)].map((address) => ({ address })) } : {}),
  };
}
