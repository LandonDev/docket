import { useMemo, useState } from "react";
import { addressesIn, missingOf, type ListedPerson } from "@shared/work/msformAnswered";
import { DialogFooter, ErrorLine } from "../../chrome/ConfirmDialog";
import { Field } from "../../chrome/DialogField";
import { Check, Copy, Search } from "../../chrome/icons";
import { Modal, ModalBody } from "../../chrome/Modal";
import { Button } from "../../components/ui/button";
import { Checkbox } from "../../components/ui/checkbox";
import { GroupInput, InputGroup } from "../../components/ui/input";
import { Skeleton } from "../../components/ui/skeleton";
import { Textarea } from "../../components/ui/textarea";
import { useWorkspaces } from "../../lib/tcserver/workspaces";
import { Face } from "../mail/face";
import { findPeople, type DirectoryPerson } from "../people/model";
import { useLifeosQuery, useLifeosSession } from "../shell/lifeos";
import { downOf } from "../shell/lifeosDown";
import { DownLine } from "../shell/DownLine";

/**
 * Who hasn't answered (docs/agents/work-msforms.md "Who has not answered"):
 * he ticks the sector's people or pastes addresses, and the dialog lists
 * those with no answer among the addresses read, with Copy addresses. A
 * Team's member list is not read (it needs Graph). Nothing is sent.
 */
export function NotAnsweredDialog({ env, workspaceId, answered, onClose }: { env: string; workspaceId: string; answered: readonly string[]; onClose: () => void }) {
  const sector = useWorkspaces().find((w) => w.id === workspaceId && w.environmentId === env)?.sector ?? null;
  // No sector, no people to pick: the session is never opened, and only pasting is offered.
  const lifeos = useLifeosSession(sector ? env : "", sector);
  const directory = useLifeosQuery<DirectoryPerson[]>(lifeos, "people:directory", { sector });
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [pasted, setPasted] = useState("");
  const [missing, setMissing] = useState<{ name?: string; email: string }[] | null>(null);
  const [listed, setListed] = useState(0);
  const [copied, setCopied] = useState(false);
  const rows = directory.status === "ready" ? directory.value : null;
  const shown = useMemo(() => (rows ? findPeople(rows, query) : []), [rows, query]);
  const list = useMemo((): ListedPerson[] => [...(rows ?? []).filter((p) => picked.has(p._id)).map((p) => ({ name: p.name, emails: p.emails })), ...addressesIn(pasted).map((e) => ({ emails: [e] }))], [rows, picked, pasted]);
  const toggle = (id: string) =>
    setPicked((now) => {
      const next = new Set(now);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  if (missing) {
    const copy = () =>
      void navigator.clipboard.writeText(missing.map((m) => m.email).join(", ")).then(
        () => setCopied(true),
        () => setCopied(false),
      );
    return (
      <Modal onClose={onClose} title="Who hasn't answered" size="sm" data-msform-dialog="not-answered">
        <ModalBody className="gap-2">
          <p className="text-[13px] text-muted-foreground tabular-nums">{missing.length ? `${missing.length} of ${listed} haven't answered` : `All ${listed} have answered`}</p>
          {missing.length ? (
            <div role="list" aria-label="Not answered" className="-mx-2 max-h-64 overflow-x-hidden overflow-y-auto">
              {missing.map((m) => (
                <div key={m.email} role="listitem" className="flex h-8 items-center gap-2 px-2 text-[13px]">
                  <span className="flex min-w-0 flex-1 items-baseline gap-1">
                    <span className="shrink-0 truncate text-foreground">{m.name ?? m.email}</span>
                    {m.name ? <span className="min-w-0 truncate text-xs text-muted-foreground select-text">{m.email}</span> : null}
                  </span>
                </div>
              ))}
            </div>
          ) : null}
        </ModalBody>
        <DialogFooter
          start={
            <Button variant="ghost" onClick={() => (setMissing(null), setCopied(false))}>
              Back
            </Button>
          }
          onCancel={onClose}
        >
          {missing.length ? (
            <Button data-dialog-confirm onClick={copy}>
              {copied ? <Check /> : <Copy />}
              {copied ? "Copied" : "Copy addresses"}
            </Button>
          ) : null}
        </DialogFooter>
      </Modal>
    );
  }

  return (
    <Modal onClose={onClose} title="Who hasn't answered" size="sm" data-msform-dialog="not-answered">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!list.length) return;
          setListed(list.length);
          setMissing(missingOf(answered, list));
        }}
      >
        <ModalBody className="gap-3">
          {sector ? (
            <>
              <InputGroup role="search" leading={<Search />}>
                <GroupInput autoFocus aria-label="Search people" placeholder="Search people" value={query} onChange={(e) => setQuery(e.currentTarget.value)} autoComplete="off" spellCheck={false} />
              </InputGroup>
              {/* A fixed height, so the dialog holds still while the list narrows. */}
              <div role="group" aria-label="People" className="-mx-2 h-48 overflow-x-hidden overflow-y-auto">
                {shown.map((person) => (
                  // The whole row takes the pointer; the box inside it takes the keyboard.
                  <div key={person._id} data-pick-row={person._id} className="flex h-8 cursor-default items-center gap-2 rounded-md px-2 text-[13px] transition-colors duration-(--dur-hover) hover:bg-foreground/5" onClick={() => toggle(person._id)}>
                    <Checkbox aria-label={person.name} checked={picked.has(person._id)} onCheckedChange={() => toggle(person._id)} onClick={(e) => e.stopPropagation()} />
                    <Face name={person.name} size="row" />
                    <span className="flex min-w-0 flex-1 items-baseline gap-1">
                      <span className="shrink-0 truncate text-foreground">{person.name}</span>
                      {person.emails[0] ? <span className="min-w-0 truncate text-xs text-muted-foreground">{person.emails[0]}</span> : null}
                    </span>
                  </div>
                ))}
                {directory.status === "loading" ? <ListBones /> : null}
                {rows && !shown.length ? <p className="px-2 py-1.5 text-[13px] text-muted-foreground">{query.trim() ? "No matches" : "No people in this job yet"}</p> : null}
              </div>
            </>
          ) : null}
          <Field label={sector ? "Or paste addresses" : "Paste addresses"}>
            <Textarea value={pasted} onChange={(e) => setPasted(e.currentTarget.value)} rows={3} className="max-h-32 min-h-16 text-[13px]" spellCheck={false} {...(sector ? {} : { autoFocus: true })} />
          </Field>
          {/* The session dropped: its line with the rule's press, the ticks and pasted addresses kept; Check needs no LifeOS. */}
          {sector && downOf(lifeos) ? <DownLine data-people-down session={lifeos} /> : <ErrorLine error={directory.status === "failed" ? `People did not load: ${directory.error}` : null} />}
        </ModalBody>
        <DialogFooter onCancel={onClose} confirmLabel="Check" disabled={!list.length} note={list.length ? `${list.length} on the list` : undefined} />
      </form>
    </Modal>
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
