import { useMemo, useState } from "react";
import type { PrepAddedPerson, PrepPage } from "@shared/contract-work-prep";
import { DialogFooter, ErrorLine } from "../../chrome/ConfirmDialog";
import { Search } from "../../chrome/icons";
import { Modal, ModalBody, useModalClose } from "../../chrome/Modal";
import { Button } from "../../components/ui/button";
import { Checkbox } from "../../components/ui/checkbox";
import { GroupInput, InputGroup } from "../../components/ui/input";
import { Skeleton } from "../../components/ui/skeleton";
import { refusalWords } from "../../lib/settingsHome";
import { Face } from "../mail/face";
import { findPeople, pictureOf, type DirectoryPerson } from "../people/model";
import { useLifeosQuery, type LifeosSession } from "../shell/lifeos";
import { setPrepPeople } from "./data";
import { addedKey, pickable } from "./model";

/**
 * The page's dialogs (docs/agents/work-prep.md "Dialogs"), a chunk of their
 * own so the page's first paint carries neither.
 */

/**
 * Add people: the sector's people from LifeOS, searched and ticked, kept with
 * the page for the series. A calendar that lists no attendees (Teams, an ICS
 * feed) leaves a page with no one on it; this is how he says who is coming.
 */
export function AddPeopleDialog({ env, lifeos, page, faces, onClose }: { env: string; lifeos: LifeosSession; page: PrepPage; faces: ReadonlyMap<string, string>; onClose: () => void }) {
  const [pending, setPending] = useState(false);
  return (
    <Modal onClose={onClose} title="Add people" size="sm" busy={pending} data-prep-dialog="people">
      <PeopleForm env={env} lifeos={lifeos} page={page} faces={faces} onClose={onClose} pending={pending} setPending={setPending} />
    </Modal>
  );
}

function PeopleForm({ env, lifeos, page, faces, onClose, pending, setPending }: { env: string; lifeos: LifeosSession; page: PrepPage; faces: ReadonlyMap<string, string>; onClose: () => void; pending: boolean; setPending: (p: boolean) => void }) {
  const close = useModalClose();
  const directory = useLifeosQuery<DirectoryPerson[]>(lifeos, "people:directory", { sector: page.sector });
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<PrepAddedPerson[]>(page.doc.people);
  const [error, setError] = useState<string | null>(null);
  const rows = directory.status === "ready" ? directory.value : null;
  // Everyone who can be ticked: those already added (a name he typed among them), then the sector's people not on the event itself.
  const all = useMemo(() => pickable(page, rows ?? []), [page, rows]);
  const shown = useMemo(() => {
    const kept = new Set(findPeople(all.map((p) => ({ _id: addedKey(p), name: p.name, emails: p.address ? [p.address] : [] })), query).map((p) => p._id));
    return all.filter((p) => kept.has(addedKey(p)));
  }, [all, query]);
  const ticked = new Set(picked.map(addedKey));
  const toggle = (person: PrepAddedPerson) => setPicked((now) => (now.some((p) => addedKey(p) === addedKey(person)) ? now.filter((p) => addedKey(p) !== addedKey(person)) : [...now, person]));
  const typed = query.trim();
  const canName = typed.length > 0 && !all.some((p) => p.name.toLowerCase() === typed.toLowerCase()) && !picked.some((p) => p.name.toLowerCase() === typed.toLowerCase());

  const submit = () => {
    setError(null);
    setPending(true);
    setPrepPeople(env, page.workspaceId, page.event.id, picked).then(
      () => {
        setPending(false);
        close ? close(onClose) : onClose();
      },
      (err: unknown) => {
        setPending(false);
        setError(refusalWords(err) || "The host did not answer");
      },
    );
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <ModalBody className="gap-3">
        <InputGroup role="search" leading={<Search />}>
          <GroupInput autoFocus aria-label="Search people" placeholder="Search" value={query} onChange={(e) => setQuery(e.currentTarget.value)} autoComplete="off" spellCheck={false} />
        </InputGroup>
        {/* A fixed height, so the dialog holds still while the list narrows. */}
        <div role="group" aria-label="People" className="-mx-2 h-64 overflow-x-hidden overflow-y-auto">
          {directory.status === "loading" && !all.length ? <ListBones /> : null}
          {shown.map((person) => {
            const key = addedKey(person);
            return (
              // The whole row takes the pointer; the box inside it takes the keyboard.
              <div key={key} data-pick-row={key} className="flex h-8 cursor-default items-center gap-2 rounded-md px-2 text-[13px] transition-colors duration-(--dur-hover) hover:bg-foreground/5" onClick={() => toggle(person)}>
                <Checkbox aria-label={person.name} checked={ticked.has(key)} onCheckedChange={() => toggle(person)} onClick={(e) => e.stopPropagation()} />
                <Face name={person.name} picture={person.address ? pictureOf([person.address], faces) : undefined} size="row" />
                <span className="flex min-w-0 flex-1 items-baseline gap-1">
                  <span className="shrink-0 truncate text-foreground">{person.name}</span>
                  {person.address ? <span className="min-w-0 truncate text-xs text-muted-foreground">{person.address}</span> : null}
                </span>
              </div>
            );
          })}
          {rows && !shown.length && !canName ? <p className="px-2 py-1.5 text-[13px] text-muted-foreground">{typed ? "No matches" : "No people in this job yet"}</p> : null}
          {canName ? (
            <div className="flex h-8 items-center px-0.5">
              <Button
                variant="ghost"
                size="xs"
                onClick={() => {
                  toggle({ name: typed });
                  setQuery("");
                }}
              >
                Add “{typed}” by name
              </Button>
            </div>
          ) : null}
        </div>
        <ErrorLine error={error ?? (directory.status === "failed" ? `People did not load: ${directory.error}` : null)} />
      </ModalBody>
      <DialogFooter onCancel={onClose} confirmLabel="Save" pending={pending} />
    </form>
  );
}

function ListBones() {
  return (
    <div aria-busy className="flex flex-col px-2">
      {[46, 34, 52, 40].map((w, i) => (
        <div key={i} className="flex h-8 items-center gap-2">
          <Skeleton className="size-4 rounded-[4px]" />
          <Skeleton className="size-6 rounded-full" />
          <Skeleton className="h-3" style={{ width: `${w}%` }} />
        </div>
      ))}
    </div>
  );
}
