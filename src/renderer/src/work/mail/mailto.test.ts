/** Mail's door for a new mail asked for from outside it: a draft for one job's workspace reaches that job's mailbox and no other. */
import { afterEach, describe, expect, it } from "vitest";
import type { MailtoDraft } from "work-kit/mail";
import { mailTo, onMailto, writeMail } from "./mailto";

const draft = (subject: string): MailtoDraft => ({ ...mailTo(["dana@example.com"]), subject });
const tick = () => new Promise<void>((resolve) => queueMicrotask(resolve));
const offs: (() => void)[] = [];
const mailbox = (workspaceId?: string) => {
  const heard: string[] = [];
  offs.push(onMailto((d) => void heard.push(d.subject), workspaceId));
  return heard;
};

afterEach(() => {
  for (const off of offs.splice(0)) off();
  // Nothing a test left waiting reaches the next: a mailbox of another job takes it away.
  offs.push(onMailto(() => {}, "ws_none"));
  for (const off of offs.splice(0)) off();
});

describe("writeMail", () => {
  it("gives a draft of no job to the newest mailbox, as a person's Write always did", async () => {
    const purdue = mailbox("ws_purdue");
    writeMail(draft("Hello"));
    expect(purdue).toEqual(["Hello"]);
  });

  it("never gives a job's draft to another job's mailbox on screen: it waits for its own", async () => {
    const purdue = mailbox("ws_purdue");
    writeMail(draft("Running late: Varsity Basketball"), "ws_ref");
    expect(purdue).toEqual([]);
    offs.shift()?.();
    const ref = mailbox("ws_ref");
    await tick();
    expect(ref).toEqual(["Running late: Varsity Basketball"]);
  });

  it("drops a waiting job's draft when another job's mailbox opens first, so it never turns up in a later Mail", async () => {
    writeMail(draft("Running late: Varsity Basketball"), "ws_ref");
    const purdue = mailbox("ws_purdue");
    await tick();
    expect(purdue).toEqual([]);
    offs.shift()?.();
    const ref = mailbox("ws_ref");
    await tick();
    expect(ref).toEqual([]);
  });

  it("gives a job's draft to that job's mailbox at once when it is the one listening", async () => {
    const ref = mailbox("ws_ref");
    writeMail(draft("Running late"), "ws_ref");
    expect(ref).toEqual(["Running late"]);
  });
});
