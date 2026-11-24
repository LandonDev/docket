// @vitest-environment jsdom
/**
 * Who in a mail is one of the sector's people (people.ts): the mail client's `people` hooks read LifeOS's
 * `people:directory` for the client's own sector, so work-kit's PersonPress makes a known sender a press that opens
 * their page in People (`openPerson`), and leaves anyone else, or every name of a client of all sectors, as text.
 */
import { act, cleanup, render, screen } from "@testing-library/react";
import { ConvexProvider, type ConvexReactClient } from "convex/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MailClientProvider, useMailClient } from "work-kit/mail";

vi.mock("../../lib/connection", () => ({ registry: { linkOf: () => ({ request: async () => null }) } }));
vi.mock("../../components/ui/toaster", () => ({ loadToast: async () => Object.assign(() => undefined, { error: () => undefined }) }));

const { mailClientFor } = await import("./client");
const { mailPeopleFor, peopleIndexOf } = await import("./people");
const { tempcodeMailKit } = await import("./kit");
const { openWorkView, workViewNow } = await import("../../lib/workSwitch");

const DANA = { _id: "p1", name: "Dana Lee", emails: ["Dana@Example.com"] };

/** A Convex client that answers `people:directory` from `rows`, and says which sector was asked. */
function fakeConvex(rows: unknown) {
  const asked: unknown[] = [];
  const listeners = new Set<() => void>();
  let answer = rows;
  const client = {
    watchQuery: (_ref: unknown, args: unknown) => {
      asked.push(args);
      return {
        localQueryResult: () => {
          if (answer instanceof Error) throw answer;
          return answer;
        },
        onUpdate: (l: () => void) => (listeners.add(l), () => listeners.delete(l)),
      };
    },
  } as unknown as ConvexReactClient;
  return { client, asked, answer: (next: unknown) => act(() => ((answer = next), listeners.forEach((l) => l()))) };
}

function Known({ address }: { address: string }) {
  const person = useMailClient().usePersonByEmail(address);
  return <span>{person ? `known ${address}` : `plain ${address}`}</span>;
}

const mount = (scope: string, convex: ConvexReactClient) =>
  render(
    <ConvexProvider client={convex}>
      <MailClientProvider client={mailClientFor("env_box", `https://lifeos.test/${scope}`, scope)}>
        <Known address="dana@example.com" />
        <Known address="sam@example.com" />
      </MailClientProvider>
    </ConvexProvider>,
  );

afterEach(() => {
  cleanup();
  openWorkView(null);
});

describe("a mail's people", () => {
  it("knows a sector's person by any spelling of her address, and no one else; the directory is the client's own sector's", async () => {
    const convex = fakeConvex(undefined);
    mount("purdue", convex.client);
    // Until the directory answers, every name stays as it is.
    expect(screen.getByText("plain dana@example.com")).toBeTruthy();
    convex.answer([DANA]);
    expect(await screen.findByText("known dana@example.com")).toBeTruthy();
    expect(screen.getByText("plain sam@example.com")).toBeTruthy();
    expect(convex.asked.every((a) => JSON.stringify(a) === JSON.stringify({ sector: "purdue" }))).toBe(true);
    // A directory LifeOS refuses knows no one, and throws nothing into the mail.
    convex.answer(new Error("not signed in"));
    expect(await screen.findByText("plain dana@example.com")).toBeTruthy();
  });

  it("knows no one in a client of every sector: a person is known in a sector, never across them", () => {
    expect(mailPeopleFor("all")).toBeUndefined();
    const convex = fakeConvex([DANA]);
    mount("all", convex.client);
    expect(screen.getByText("plain dana@example.com")).toBeTruthy();
    expect(convex.asked).toEqual([]);
  });

  it("reads one index per answer, by lower-cased address", () => {
    const rows = [DANA, { _id: "p2", name: "Sam", emails: [" sam@x.org "] }];
    expect(peopleIndexOf(rows)).toBe(peopleIndexOf(rows));
    expect([...peopleIndexOf(rows).byEmail.keys()]).toEqual(["dana@example.com", "sam@x.org"]);
  });

  it("a known sender's press opens her page in the workspace's People", () => {
    openWorkView({ workspaceId: "ws", view: "mail" });
    tempcodeMailKit.openPerson!({ address: "dana@example.com", name: "Dana Lee" });
    expect(workViewNow()).toEqual({ workspaceId: "ws", view: "people", person: "dana@example.com" });
  });
});
