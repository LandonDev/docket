import { ConvexProvider, useMutation } from "convex/react";
import { makeFunctionReference } from "convex/server";
import { useEffect, useRef, useState } from "react";
import type { SectorKey } from "@shared/work";
import { DialogFooter, ErrorLine } from "../../chrome/ConfirmDialog";
import { Field } from "../../chrome/DialogField";
import { Modal, ModalBody, useModalClose } from "../../chrome/Modal";
import { DateField } from "../../components/ui/date-field";
import { Input } from "../../components/ui/input";
import { loadToast } from "../../components/ui/toaster";
import { workErrorWords } from "../../lib/workErrorWords";
import { jobNameNow } from "../jobName";
import type { LifeosSession } from "../shell/lifeos";
import { downOf } from "../shell/lifeosDown";
import { DownLine, HostLine } from "../shell/DownLine";
import { useHostLive } from "../shell/lifeosLive";
import { OfflineLine } from "./OfflineLine";
import { useComputerOffline } from "./offline";

/**
 * New task (prototype workspace.html, the Tasks header's verb): a plain write
 * to LifeOS in the workspace's sector, filed as LifeOS's own quick add files
 * one, so its Undo takes it back by its key. It holds nothing: a task he
 * writes himself goes at once.
 */

const create = makeFunctionReference<"mutation">("tasks:create");
const takeBack = makeFunctionReference<"mutation">("tasks:takeBack");

/** A due day with no time is 9:00 that morning, as LifeOS reads one. */
export const dueOf = (day: string): number | undefined => (day ? new Date(`${day}T09:00`).getTime() : undefined);

/** Who files the task in place of the plain write: Mail's Make task, which also links it to its mail. */
export type FileTask = (task: { title: string; dueAt?: number }) => Promise<void> | void;

type Writes = { add: (args: Record<string, unknown>) => Promise<unknown>; undo: (args: { key: string }) => Promise<unknown> };

/** The form's writes, made only while there is a client to make them through: none while the session is down. */
function Live({ onWrites }: { onWrites: (writes: Writes | null) => void }) {
  const add = useMutation(create);
  const undo = useMutation(takeBack);
  // One lasting pair over the newest callers: a caller made anew by a render must not hand the form new writes, which
  // would draw it again, and so on without end.
  const latest = useRef({ add, undo });
  useEffect(() => {
    latest.current = { add, undo };
  });
  useEffect(() => {
    onWrites({ add: (args) => latest.current.add(args), undo: (args) => latest.current.undo(args) });
    return () => onWrites(null);
  }, [onWrites]);
  return null;
}

export function NewTaskDialog({
  sector,
  initial,
  file,
  onAdded,
  onClose,
  session,
}: {
  sector: SectorKey;
  /** what the form starts with (a mail chat's proposed task); he still saves it */
  initial?: { title?: string; due?: string };
  file?: FileTask;
  /** after his Add went through */
  onAdded?: () => void;
  onClose: () => void;
  /**
   * The session it writes through, where the form outlives the view's body (`WorkViewModule.Kept`): while it is down,
   * the form keeps what he typed, says its line (`DownLine`) and holds Add; while the host says it is connecting, the
   * named wait (`HostLine`) with Add held. Without it, the form writes through the
   * Convex client around it.
   */
  session?: LifeosSession;
}) {
  const [pending, setPending] = useState(false);
  return (
    <Modal onClose={onClose} title="New task" size="sm" busy={pending}>
      <Body sector={sector} initial={initial} file={file} onAdded={onAdded} onClose={onClose} pending={pending} setPending={setPending} session={session} />
    </Modal>
  );
}

function Body({
  sector,
  initial,
  file,
  onAdded,
  onClose,
  pending,
  setPending,
  session,
}: {
  sector: SectorKey;
  initial?: { title?: string; due?: string };
  file?: FileTask;
  onAdded?: () => void;
  onClose: () => void;
  pending: boolean;
  setPending: (p: boolean) => void;
  session?: LifeosSession;
}) {
  const close = useModalClose();
  const [writes, setWrites] = useState<Writes | null>(null);
  const down = session && downOf(session) ? session : null;
  // The host said its LifeOS is on its way: the named wait, Add held, what he typed kept.
  const host = useHostLive(session?.environmentId ?? "");
  const waits = !!session && !session.client && !down && host.waits;
  const offline = useComputerOffline();
  // Add waits for a client to write through: the session it writes on (writers mounted under a client since closed
  // write nowhere), the form's own writes unless Mail's Make task files it, and this computer online.
  const held = (!!session && !session.client) || (!file && !writes) || offline;
  const [title, setTitle] = useState(initial?.title ?? "");
  const [due, setDue] = useState(initial?.due ?? "");
  const [error, setError] = useState<string | null>(null);
  const save = () => {
    const words = title.trim();
    if (!words) return setError("Say what to do");
    if (held) return;
    const key = crypto.randomUUID();
    const dueAt = dueOf(due);
    setError(null);
    setPending(true);
    if (file) {
      // Mail's Make task says its own toast, with its own Undo.
      Promise.resolve(file({ title: words, ...(dueAt !== undefined ? { dueAt } : {}) })).then(
        () => {
          setPending(false);
          onAdded?.();
          close ? close(onClose) : onClose();
        },
        (err: unknown) => {
          setPending(false);
          setError(workErrorWords(err) || "LifeOS did not add the task");
        },
      );
      return;
    }
    const { add, undo } = writes!;
    add({ sector, title: words, key, source: { kind: "manual", container: "quick-add", channel: "Typed", messageId: key, sentAt: Date.now() }, ...(dueAt !== undefined ? { dueAt } : {}) }).then(
      () => {
        setPending(false);
        onAdded?.();
        void loadToast().then((toast) => toast(`Added to ${jobNameNow(sector)}`, { action: { label: "Undo", onClick: () => void undo({ key }).catch(() => toast.error("Did not undo")) } }));
        close ? close(onClose) : onClose();
      },
      (err: unknown) => {
        setPending(false);
        setError(workErrorWords(err) || "LifeOS did not add the task");
      },
    );
  };
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      {session ? (
        session.client ? (
          <ConvexProvider client={session.client}>
            <Live onWrites={setWrites} />
          </ConvexProvider>
        ) : null
      ) : (
        <Live onWrites={setWrites} />
      )}
      <ModalBody>
        {/* The session dropped while the form was open: its line, with the rule's press; what he typed stays. */}
        {down ? <DownLine session={down} /> : offline ? <OfflineLine /> : waits ? <HostLine live={host} /> : null}
        <Field label="Task">
          <Input value={title} onChange={(e) => setTitle(e.target.value)} autoComplete="off" />
        </Field>
        <Field label="Due">
          <DateField value={due} onChange={setDue} />
        </Field>
        <ErrorLine error={error} />
      </ModalBody>
      <DialogFooter onCancel={onClose} confirmLabel="Add" pending={pending} disabled={held} />
    </form>
  );
}
