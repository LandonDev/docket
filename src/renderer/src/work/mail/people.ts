import { useEffect, useState } from "react";
import { useConvex } from "convex/react";
import { makeFunctionReference } from "convex/server";
import type { MailPeople, MailPerson } from "work-kit/mail";
import type { DirectoryPerson } from "../people/model";

/**
 * Who in a mail is one of the sector's people (docs/agents/work-mail.md "People"): work-kit's `people` hooks for
 * `createLifeosMailClient`, read from the People pillar's own source, LifeOS's `people:directory` for that one
 * sector, on the Mail view's own session. A known sender or recipient is then a press (work-kit's `PersonPress`)
 * that opens their page in People (`openPerson`, kit.tsx). A client of every sector ("all") knows no one: a person
 * is known in a sector, never across them. Until the directory answers, or when it cannot, no one is known and
 * every name stays as it is.
 */

const DIRECTORY = makeFunctionReference<"query">("people:directory");

/** One index per answer of the directory, shared by every hook that read it. */
const indexes = new WeakMap<object, MailPeople>();

/** The directory as an index by address, lower-cased: work-kit only asks whether an address is known. */
export function peopleIndexOf(rows: readonly DirectoryPerson[]): MailPeople {
  let index = indexes.get(rows);
  if (!index) {
    const byEmail = new Map<string, MailPerson>();
    for (const person of rows) for (const email of person.emails) byEmail.set(email.trim().toLowerCase(), person as MailPerson);
    index = { byEmail };
    indexes.set(rows, index);
  }
  return index;
}

/** The sector's directory, live, as an index; undefined while it loads or when LifeOS refuses it (never thrown into the mail). */
function useSectorPeople(sector: string): MailPeople | undefined {
  const convex = useConvex();
  const [index, setIndex] = useState<MailPeople | undefined>(undefined);
  useEffect(() => {
    const watch = convex.watchQuery(DIRECTORY, { sector });
    const read = (): void => {
      try {
        const rows = watch.localQueryResult() as DirectoryPerson[] | undefined;
        setIndex(rows ? peopleIndexOf(rows) : undefined);
      } catch {
        setIndex(undefined);
      }
    };
    read();
    return watch.onUpdate(read);
  }, [convex, sector]);
  return index;
}

/** The `people` option for a mail client of `scope` (a sector, or "all"): undefined for "all", which knows no one. */
export function mailPeopleFor(scope: string): { usePeopleIndex(): MailPeople | undefined; usePersonByEmail(address: string | undefined): MailPerson | undefined } | undefined {
  if (scope === "all") return undefined;
  const usePeopleIndex = (): MailPeople | undefined => useSectorPeople(scope);
  return {
    usePeopleIndex,
    usePersonByEmail(address) {
      const index = usePeopleIndex();
      return address ? index?.byEmail.get(address.trim().toLowerCase()) : undefined;
    },
  };
}
