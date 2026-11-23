import { useMemo, useRef, useState } from "react";
import type { PrepAddedPerson, PrepPage } from "@shared/contract-work-prep";
import { DialogFooter, ErrorLine } from "../../chrome/ConfirmDialog";
import { Search } from "../../chrome/icons";
import { Modal, ModalBody, useModalClose } from "../../chrome/Modal";
import { BusyLabel, Button } from "../../components/ui/button";
import { Checkbox } from "../../components/ui/checkbox";
import { GroupInput, InputGroup } from "../../components/ui/input";
import { Progress } from "../../components/ui/progress";
import { Skeleton } from "../../components/ui/skeleton";
import { Spinner } from "../../components/ui/spinner";
import { Textarea } from "../../components/ui/textarea";
import { modOrCtrl } from "../../lib/keys";
import { refusalWords } from "../../lib/settingsHome";
import { useSessionMetaValue } from "../../lib/tcserver/store";
import { Face } from "../mail/face";
import { findPeople, pictureOf, type DirectoryPerson } from "../people/model";
import { useLifeosQuery, type LifeosQuery, type LifeosSession } from "../shell/lifeos";
import { dropNotes, followUpFromFile, followUpPrep, heldNotes, holdNotes, keepPrepNotes, loadPrep, notesDocPrep, openWorkspaceFile, setPrepPeople } from "./data";
import { addedKey, NOTES_FILE_ACCEPT, pickable, returnPicks, samePeople, threadStopped, uploadPercent } from "./model";

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
  // A name he typed and added stays in the list, ticked, though he may untick it again: so the list remembers every pick of this sitting.
  const [named, setNamed] = useState<PrepAddedPerson[]>([]);
  const all = useMemo(() => pickable(page, rows ?? [], named), [page, rows, named]);
  const shown = useMemo(() => {
    const kept = new Set(findPeople(all.map((p) => ({ _id: addedKey(p), name: p.name, emails: p.address ? [p.address] : [] })), query).map((p) => p._id));
    return all.filter((p) => kept.has(addedKey(p)));
  }, [all, query]);
  const ticked = new Set(picked.map(addedKey));
  // While Save is on its way the list holds still: a tick made after the request left would show and never be kept.
  const toggle = (person: PrepAddedPerson) => {
    if (!pending) setPicked((now) => (now.some((p) => addedKey(p) === addedKey(person)) ? now.filter((p) => addedKey(p) !== addedKey(person)) : [...now, person]));
  };
  const typed = query.trim();
  const canName = typed.length > 0 && !all.some((p) => p.name.toLowerCase() === typed.toLowerCase());
  const addNamed = () => {
    if (pending) return;
    const person = { name: typed };
    setNamed((now) => [...now, person]);
    setPicked((now) => [...now, person]);
    setQuery("");
  };

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
          <GroupInput
            autoFocus
            aria-label="Search people"
            placeholder="Search"
            value={query}
            // Read only, not disabled, while Save is on its way: the caret keeps its place if the host refuses.
            readOnly={pending}
            onChange={(e) => setQuery(e.currentTarget.value)}
            // Return in the search never saves. It adds the typed name when the list has no one for it, and ticks the one person it shows.
            onKeyDown={(e) => {
              if (e.key !== "Enter") return;
              e.preventDefault();
              const does = returnPicks(typed, shown.length, canName);
              if (does === "name") addNamed();
              else if (does === "tick") toggle(shown[0]!);
            }}
            autoComplete="off"
            spellCheck={false}
          />
        </InputGroup>
        {/* A fixed height, so the dialog holds still while the list narrows. */}
        <div role="group" aria-label="People" className="-mx-2 h-64 overflow-x-hidden overflow-y-auto">
          {shown.map((person) => {
            const key = addedKey(person);
            return (
              // The whole row takes the pointer; the box inside it takes the keyboard.
              <div key={key} data-pick-row={key} className="flex h-8 cursor-default items-center gap-2 rounded-md px-2 text-[13px] transition-colors duration-(--dur-hover) hover:bg-foreground/5" onClick={() => toggle(person)}>
                <Checkbox aria-label={person.name} checked={ticked.has(key)} disabled={pending} onCheckedChange={() => toggle(person)} onClick={(e) => e.stopPropagation()} />
                <Face name={person.name} picture={person.address ? pictureOf([person.address], faces) : undefined} size="row" />
                <span className="flex min-w-0 flex-1 items-baseline gap-1">
                  <span className="shrink-0 truncate text-foreground">{person.name}</span>
                  {person.address ? <span className="min-w-0 truncate text-xs text-muted-foreground">{person.address}</span> : null}
                </span>
              </div>
            );
          })}
          {/* The directory is still on its way: its bones stand under whoever is already added, so a list half read never looks whole. */}
          {directory.status === "loading" ? <ListBones /> : null}
          {rows && !shown.length && !canName ? <p className="px-2 py-1.5 text-[13px] text-muted-foreground">{typed ? "No matches" : "No people in this job yet"}</p> : null}
          {canName ? (
            <div className="flex h-8 items-center px-0.5">
              <Button variant="ghost" size="xs" disabled={pending} onClick={addNamed}>
                Add “{typed}” by name
              </Button>
            </div>
          ) : null}
        </div>
        <ErrorLine error={error ?? (directory.status === "failed" ? `People did not load: ${directory.error}` : null)} />
      </ModalBody>
      {/* Save is for a change: with the same people ticked as the page keeps, there is nothing to save. */}
      <DialogFooter onCancel={onClose} confirmLabel="Save" pending={pending} disabled={samePeople(picked, page.doc.people)} />
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
  const { workspaceId } = page;
  const eventId = page.event.id;
  // A sitting whose save did not go through opens again on what he typed, with why.
  const unsaved = heldNotes(workspaceId, eventId);
  const before = page.doc.notes?.text ?? "";
  const [text, setText] = useState(unsaved?.text ?? before);
  const [pending, setPending] = useState<"follow" | "close" | null>(null);
  const [upload, setUpload] = useState<{ name: string; progress: { sent: number; total: number } | null } | null>(null);
  const [error, setError] = useState<string | null>(unsaved?.error ?? null);
  // What the host holds: a change from it is what a close has to keep.
  const kept = useRef(before);
  const changed = () => text.trim() !== kept.current.trim();
  // A follow-up thread this window holds and knows has stopped is not waited on, as from the header's verb.
  const restart = threadStopped(page.followSessionId, useSessionMetaValue(page.followSessionId, (meta) => meta.status));
  const keep = async () => {
    if (!changed()) return;
    await keepPrepNotes(env, workspaceId, eventId, text);
    kept.current = text;
    dropNotes(workspaceId, eventId);
  };
  const failed = (err: unknown) => {
    const why = refusalWords(err) || "The host did not answer";
    setPending(null);
    setUpload(null);
    setError(why);
    return why;
  };
  /** Keeps what he typed, then runs the follow-up; a failure is the dialog's own line. */
  const run = (work: () => Promise<unknown>, done: () => void) => {
    setError(null);
    setPending("follow");
    keep()
      .then(work)
      .then(() => {
        setPending(null);
        void loadPrep(env, workspaceId, eventId);
        done();
      }, failed);
  };
  /**
   * Cancel and the footer's close: what he typed is kept first, and the dialog leaves only once the host has it. A
   * save the host refuses keeps the dialog open on his words, with why.
   */
  const saveThenClose = (done: () => void) => {
    if (!changed()) return done();
    setError(null);
    setPending("close");
    keep().then(() => {
      setPending(null);
      done();
    }, failed);
  };
  /**
   * Escape, the backdrop and the corner's close leave at once (the shell plays their exit first). What he typed is
   * sent then; if the host does not take it, it is held for this meeting and the dialog opens again on it.
   */
  const closed = () => {
    if (changed()) {
      const typed = text;
      keepPrepNotes(env, workspaceId, eventId, typed).then(
        () => dropNotes(workspaceId, eventId),
        (err: unknown) => {
          holdNotes(workspaceId, eventId, typed, `The notes were not kept: ${refusalWords(err) || "the host did not answer"}`);
          reopenNotes.current?.(workspaceId, eventId);
        },
      );
    }
    onClose();
  };
  return (
    <Modal onClose={closed} title="Notes" size="md" busy={pending !== null} data-prep-dialog="notes">
      <NotesForm
        text={text}
        setText={setText}
        pending={pending}
        upload={upload}
        error={error}
        onCancel={saveThenClose}
        onClose={onClose}
        onFollowUp={(done) => run(() => followUpPrep(env, workspaceId, eventId, restart), done)}
        onFile={(file, done) => {
          setUpload({ name: file.name, progress: null });
          run(() => followUpFromFile(env, workspaceId, eventId, file, { onProgress: (progress) => setUpload({ name: file.name, progress }), restart, typed: text }), done);
        }}
        // The document is his to write in: it opens beside a new thread, and the page keeps it as the notes.
        onDocument={(done) => run(async () => openWorkspaceFile(env, await notesDocPrep(env, workspaceId, eventId)), done)}
      />
    </Modal>
  );
}

/** How the page opens the Notes dialog again, for a close whose save failed after the dialog had gone: it is told whose notes they were, and opens only on that meeting's own page. */
export const reopenNotes: { current: ((workspaceId: string, eventId: string) => void) | null } = { current: null };

/** The Notes dialog's inside, holding no call of its own: the preview draws it as the app does. */
export function NotesForm({
  text,
  setText,
  pending,
  upload,
  error,
  onCancel,
  onClose,
  onFollowUp,
  onFile,
  onDocument,
}: {
  text: string;
  setText: (text: string) => void;
  /** the work in flight: a follow-up starting (its button spins), or a close that is keeping his words (Cancel spins) */
  pending: "follow" | "close" | null;
  upload: { name: string; progress: { sent: number; total: number } | null } | null;
  error: string | null;
  /** Cancel: keep what he typed, then `done` */
  onCancel: (done: () => void) => void;
  /** the page's own close, run once the dialog's exit has played */
  onClose: () => void;
  onFollowUp: (done: () => void) => void;
  onFile: (file: File, done: () => void) => void;
  onDocument: (done: () => void) => void;
}) {
  const close = useModalClose();
  const input = useRef<HTMLInputElement>(null);
  const empty = !text.trim();
  const busy = pending !== null;
  // The work is done by the time this runs: the shell plays its exit, then the page forgets the dialog, so it can open again.
  const done = () => (close ? close(onClose) : onClose());
  const submit = () => {
    if (!empty && !busy) onFollowUp(done);
  };
  const percent = upload ? uploadPercent(upload.progress) : null;
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
          disabled={busy}
          onChange={(e) => setText(e.currentTarget.value)}
          // A fixed height that scrolls: the dialog holds still as he types or pastes a page of notes.
          className="field-sizing-fixed h-72 resize-none overflow-x-hidden overflow-y-auto text-sm leading-[22px]"
        />
        {/* The other ways in: a recording or the transcript Teams or Zoom wrote, read on the workspace's own host; or a document of the job's Meeting notes template. */}
        <div className="flex min-h-6 items-center text-xs text-muted-foreground">
          {upload ? (
            // The file's name gives way; how far it is never does. A bar once the size is known, a spinner until then.
            <Progress value={percent} aria-label={`Uploading ${upload.name}`} className="w-full items-center gap-x-2 gap-y-1">
              <span className="flex min-w-0 flex-1 items-center gap-1.5">
                {percent === null ? <Spinner aria-hidden className="size-3 shrink-0" /> : null}
                <span className="min-w-0 truncate">Uploading {upload.name}</span>
              </span>
              {percent !== null ? <span className="shrink-0 tabular-nums">{percent}%</span> : null}
            </Progress>
          ) : (
            <span className="-ms-2 flex flex-wrap items-center gap-x-1">
              <Button variant="ghost" size="xs" className="font-normal text-muted-foreground" disabled={busy} onClick={() => input.current?.click()}>
                Use a recording or transcript
              </Button>
              <Button variant="ghost" size="xs" className="font-normal text-muted-foreground" disabled={busy} onClick={() => onDocument(done)}>
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
      {/* The footer's own shape, with its Cancel a verb of this dialog's: it keeps his words before it closes, and spins while it does. */}
      <DialogFooter confirmLabel="Follow up" pending={pending === "follow" && !upload} busy={busy} disabled={empty}>
        <Button data-dialog-cancel variant="secondary" disabled={busy} onClick={() => onCancel(done)}>
          <BusyLabel busy={pending === "close"} label="Cancel" />
        </Button>
      </DialogFooter>
    </form>
  );
}
