import { useMemo, useRef, useState } from "react";
import type { PrepAddedPerson, PrepPage } from "@shared/contract-work-prep";
import { DialogFooter, ErrorLine } from "../../chrome/ConfirmDialog";
import { Search } from "../../chrome/icons";
import { Modal, ModalBody, useModalClose } from "../../chrome/Modal";
import { Button } from "../../components/ui/button";
import { Checkbox } from "../../components/ui/checkbox";
import { GroupInput, InputGroup } from "../../components/ui/input";
import { Skeleton } from "../../components/ui/skeleton";
import { Textarea } from "../../components/ui/textarea";
import { loadToast } from "../../components/ui/toaster";
import { modOrCtrl } from "../../lib/keys";
import { refusalWords } from "../../lib/settingsHome";
import { Face } from "../mail/face";
import { findPeople, pictureOf, type DirectoryPerson } from "../people/model";
import { useLifeosQuery, type LifeosQuery, type LifeosSession } from "../shell/lifeos";
import { followUpFromFile, followUpPrep, keepPrepNotes, loadPrep, notesDocPrep, openWorkspaceFile, setPrepPeople } from "./data";
import { addedKey, NOTES_FILE_ACCEPT, pickable, uploadWords } from "./model";

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
  const directory = useLifeosQuery<DirectoryPerson[]>(lifeos, "people:directory", { sector: page.sector });
  return (
    <Modal onClose={onClose} title="Add people" size="sm" busy={pending} data-prep-dialog="people">
      <PeopleForm env={env} directory={directory} page={page} faces={faces} onClose={onClose} pending={pending} setPending={setPending} />
    </Modal>
  );
}

/** The dialog's inside, over a directory read handed to it: the preview draws it as the app does. `search`: what the field starts with. */
export function PeopleForm({
  env,
  directory,
  page,
  faces,
  onClose,
  pending,
  setPending,
  search = "",
}: {
  env: string;
  directory: LifeosQuery<DirectoryPerson[]>;
  page: PrepPage;
  faces: ReadonlyMap<string, string>;
  onClose: () => void;
  pending: boolean;
  setPending: (p: boolean) => void;
  search?: string;
}) {
  const close = useModalClose();
  const [query, setQuery] = useState(search);
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

/**
 * Notes: what he typed or pasted of the meeting, or a recording or transcript
 * of it. Follow up keeps them and starts the thread that turns them into
 * tasks and a mail draft. Closing the dialog any other way keeps what he
 * typed too, so nothing typed is lost and the header's verb becomes Follow up.
 */
export function NotesDialog({ env, page, onClose }: { env: string; page: PrepPage; onClose: () => void }) {
  const before = page.doc.notes?.text ?? "";
  const [text, setText] = useState(before);
  const [pending, setPending] = useState(false);
  const [upload, setUpload] = useState<{ name: string; progress: { sent: number; total: number } | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  // What the host holds, and what he has typed, as the close reads them (it runs after the exit has played).
  const kept = useRef(before);
  const typed = useRef(before);
  typed.current = text;
  const { workspaceId } = page;
  const eventId = page.event.id;
  const close = () => {
    if (typed.current.trim() !== kept.current.trim()) {
      void keepPrepNotes(env, workspaceId, eventId, typed.current).catch((err: unknown) => void loadToast().then((toast) => toast.error("The notes were not kept", { description: refusalWords(err) || "The host did not answer" })));
    }
    onClose();
  };
  /** Keeps what he typed, then runs the follow-up; its failure is the dialog's own line. */
  const run = (work: () => Promise<unknown>, done: () => void) => {
    setError(null);
    setPending(true);
    (text.trim() !== kept.current.trim() ? keepPrepNotes(env, workspaceId, eventId, text) : Promise.resolve())
      .then(() => {
        kept.current = text;
        return work();
      })
      .then(
        () => {
          setPending(false);
          loadPrep(env, workspaceId, eventId);
          done();
        },
        (err: unknown) => {
          setPending(false);
          setUpload(null);
          setError(refusalWords(err) || "The host did not answer");
        },
      );
  };
  return (
    <Modal onClose={close} title="Notes" size="md" busy={pending} data-prep-dialog="notes">
      <NotesForm
        text={text}
        setText={setText}
        pending={pending}
        upload={upload}
        error={error}
        onCancel={close}
        onFollowUp={(done) => run(() => followUpPrep(env, workspaceId, eventId), done)}
        onFile={(file, done) => {
          setUpload({ name: file.name, progress: null });
          run(() => followUpFromFile(env, workspaceId, eventId, file, (progress) => setUpload({ name: file.name, progress })), done);
        }}
        // The document is his to write in: it opens beside a new thread, and the page keeps it as the notes.
        onDocument={(done) => run(async () => openWorkspaceFile(env, await notesDocPrep(env, workspaceId, eventId)), done)}
      />
    </Modal>
  );
}

/** The Notes dialog's inside, holding no call of its own: the preview draws it as the app does. */
export function NotesForm({
  text,
  setText,
  pending,
  upload,
  error,
  onCancel,
  onFollowUp,
  onFile,
  onDocument,
}: {
  text: string;
  setText: (text: string) => void;
  pending: boolean;
  upload: { name: string; progress: { sent: number; total: number } | null } | null;
  error: string | null;
  onCancel: () => void;
  onFollowUp: (done: () => void) => void;
  onFile: (file: File, done: () => void) => void;
  onDocument: (done: () => void) => void;
}) {
  const close = useModalClose();
  const input = useRef<HTMLInputElement>(null);
  const empty = !text.trim();
  const done = () => (close ? close(onCancel) : onCancel());
  const submit = () => {
    if (!empty && !pending) onFollowUp(done);
  };
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      // ⌘↩ follows up from inside the field, where ↩ is a new line.
      onKeyDown={(e) => {
        if (e.key === "Enter" && modOrCtrl(e)) {
          e.preventDefault();
          submit();
        }
      }}
    >
      <ModalBody className="gap-2">
        <Textarea
          autoFocus
          aria-label="Notes"
          placeholder="What was said, what was decided, what is still open"
          value={text}
          disabled={pending}
          onChange={(e) => setText(e.currentTarget.value)}
          // A fixed height that scrolls: the dialog holds still as he types or pastes a page of notes.
          className="field-sizing-fixed h-72 resize-none overflow-x-hidden overflow-y-auto text-sm leading-[22px]"
        />
        {/* The other ways in: a recording or the transcript Teams or Zoom wrote, read on the workspace's own host; or a document of the job's Meeting notes template. */}
        <div className="flex min-h-6 items-center text-xs text-muted-foreground">
          {upload ? (
            <span role="status" className="truncate tabular-nums">
              {uploadWords(upload.name, upload.progress)}
            </span>
          ) : (
            <span className="-ms-2 flex items-center gap-1">
              <Button variant="ghost" size="xs" className="font-normal text-muted-foreground" disabled={pending} onClick={() => input.current?.click()}>
                Use a recording or transcript
              </Button>
              <Button variant="ghost" size="xs" className="font-normal text-muted-foreground" disabled={pending} onClick={() => onDocument(done)}>
                Write in a document
              </Button>
            </span>
          )}
          <input
            ref={input}
            type="file"
            hidden
            aria-label="A recording or transcript"
            accept={NOTES_FILE_ACCEPT}
            onChange={(e) => {
              const file = e.currentTarget.files?.[0];
              e.currentTarget.value = "";
              if (file) onFile(file, done);
            }}
          />
        </div>
        <ErrorLine error={error} />
      </ModalBody>
      <DialogFooter onCancel={onCancel} confirmLabel="Follow up" pending={pending && !upload} busy={!!upload} disabled={empty} />
    </form>
  );
}
