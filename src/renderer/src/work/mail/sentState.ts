import { ownZone, scheduleLine } from "work-kit/mail/lib/zones";

/** What of a LifeOS outbox row says where it stands. */
type Row = { status: string; sendAt?: number | undefined; scheduled?: boolean | undefined; sendZone?: string | undefined };

/**
 * Where a mail that left Drafts stands, one word a status; null while it is still a draft. A mail he scheduled sits
 * `queued` in LifeOS until its time, days maybe: it is "Scheduled for <its time>", never "Sending". A sent one names
 * no time: the row keeps the time of its last edit, not of its going.
 */
export function sentState(row: Row, zone = ownZone(), now = Date.now()): string | null {
  if (row.status === "sent") return "Sent";
  if (row.status === "failed") return "Not sent";
  if (row.status === "queued" && row.scheduled === true && typeof row.sendAt === "number") return `Scheduled for ${scheduleLine(row.sendAt, zone, row.sendZone, now)}`;
  return row.status === "queued" || row.status === "sending" ? "Sending" : null;
}
