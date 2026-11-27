import { useRef, useState } from "react";
import { SKILL_HARNESSES, SKILL_MD, SKILL_NAME_RE, sizeWords, skillProblem } from "@shared/skills";
import type { Skill, SkillMeta } from "@shared/contract-skills";
import { DialogFooter, ErrorLine, confirmAction } from "../../../chrome/ConfirmDialog";
import { CheckRow, Field, FieldRow } from "../../../chrome/DialogField";
import { JumpList } from "../../../chrome/JumpList";
import { ModalBody, ModalPanel } from "../../../chrome/Modal";
import { Bone, Region } from "../../../components/bones";
import { ChoiceSelect } from "../../../components/choice-select";
import { Dialog } from "../../../components/ui/dialog";
import { Input } from "../../../components/ui/input";
import type { Link } from "../../../lib/connection";
import { useHostRead } from "../../../lib/connection/hostRead";
import { refusalWords } from "../../../lib/settingsHome";
import { editorChunk } from "../../chunks";
import { ReadFailure } from "../parts/ReadFailure";
import { everyWorkspace } from "../addons/addonWords";
import { CLI_LABELS, bytesOf, canUntick, choiceOf, fileBytes, filesToSave, harnessesOf, isBinary, isDirty, newSkillFiles, orderFiles, skillTemplate, type CliChoice, type SkillDraft } from "./skillForm";

/** CodeMirror loads with the editor chunk, never with Settings. */
const SkillEditor = editorChunk.surface("SkillTextEditor", <Bone data-editor-skeleton className="h-full w-full rounded-lg" />);

/** A skill's files as the list draws them while they are read: a short one's three. */
const SAMPLE_SKILL_FILES = ["SKILL.md", "scripts/check.sh", "reference.md"] as const;
const STILL = () => {};

type Props = {
  link: Link;
  /** null: a new skill */
  skill: SkillMeta | null;
  workspaces: readonly { id: string; name: string }[];
  /** Where the one copy for every workspace is kept: "Where" names it. */
  home?: { name: string } | null;
  onClose: () => void;
  /** After the dialog's exit has played: the row the host answered. */
  onSaved: (skill: SkillMeta) => void;
};

/** "The skill was not saved" words, capitalized as a sentence. */
const sentence = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * New skill… and Edit… on Settings → Skills: the name (a new skill's only),
 * where it applies and which CLIs get it over the skill's files beside a
 * CodeMirror editor that loads on demand. The editor opens any text file,
 * SKILL.md first; a binary file is listed with its size and never opened.
 * Save sends the skill whole with the `updatedAt` it was read at, so a skill
 * that moved meanwhile is refused. Closing with unsaved edits asks first.
 * Its own `Dialog` root, since a close may have to wait for that answer.
 */
export function SkillDialog({ link, skill, workspaces, home, onClose, onSaved }: Props) {
  const read = useHostRead<{ skill: Skill }>(skill ? link : null, () => link.request<{ skill: Skill }>("skills.get", { id: skill!.id }), skill?.id ?? "");
  const loaded = read.value?.skill ?? null;
  const initial = useRef<SkillDraft>({ name: skill?.name ?? "", workspaceId: skill?.workspaceId ?? null, choice: choiceOf(skill?.harnesses ?? "all"), drafts: {} });
  const [name, setName] = useState(initial.current.name);
  const [workspaceId, setWorkspaceId] = useState(initial.current.workspaceId);
  const [choice, setChoice] = useState<CliChoice>(initial.current.choice);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [path, setPath] = useState(SKILL_MD);
  // The text file the editor holds; a binary file shown hides it, so every file keeps its undo history.
  const [textPath, setTextPath] = useState(SKILL_MD);
  const [error, setError] = useState<string | null>(null);
  const [nameError, setNameError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  // The close a dialog starts plays the exit, then runs what it chose; the first close wins.
  const [open, setOpen] = useState(true);
  const then = useRef(onClose);
  const closing = useRef(false);
  const asking = useRef(false);
  const closeThen = (fn: () => void) => {
    if (closing.current) return;
    closing.current = true;
    then.current = fn;
    setOpen(false);
  };

  const title = skill ? `Edit ${skill.name}` : "New skill";
  const files = skill ? (loaded ? orderFiles(loaded.files) : null) : newSkillFiles(name.trim(), drafts);
  const dirty = isDirty(initial.current, { name, workspaceId, choice, drafts }, loaded?.files ?? []);
  const askClose = () => {
    if (pending || asking.current) return;
    if (!dirty) {
      closeThen(onClose);
      return;
    }
    asking.current = true;
    void confirmAction({ title: `Discard changes to ${skill?.name ?? (name.trim() || "the new skill")}?`, action: "Discard", danger: true }).then((ok) => {
      asking.current = false;
      if (ok) closeThen(onClose);
    });
  };

  const save = () => {
    if (pending) return;
    const skillName = skill ? skill.name : name.trim();
    if (!skill && !SKILL_NAME_RE.test(skillName)) {
      setNameError("Lowercase letters, digits and dashes, 64 at most");
      return;
    }
    setNameError(null);
    if (skill && !loaded) return;
    const out = loaded ? filesToSave(loaded.files, drafts) : newSkillFiles(skillName, drafts);
    const problem = skillProblem(skillName, bytesOf(out));
    if (problem) {
      setError(sentence(problem));
      return;
    }
    setError(null);
    setPending(true);
    link
      .request<{ skill: SkillMeta }>("skills.set", {
        skill: { ...(skill ? { id: skill.id } : {}), name: skillName, workspaceId, harnesses: harnessesOf(choice), enabled: skill?.enabled ?? true, files: out },
        // The list row's stamp, whose fields the form started from: a skill that moved since is refused, never written over.
        expectUpdatedAt: skill?.updatedAt ?? 0,
      })
      .then(
        ({ skill: saved }) => {
          setPending(false);
          closeThen(() => onSaved(saved));
        },
        (err: unknown) => {
          setPending(false);
          setError(refusalWords(err) || "The skill was not saved");
        },
      );
  };

  const where = [{ value: "", label: everyWorkspace(home) }, ...workspaces.map((w) => ({ value: w.id, label: w.name }))];
  const current = files?.find((f) => f.path === path) ?? files?.[0];
  const textFile = files?.find((f) => f.path === textPath && !isBinary(f));
  const textOf = (p: string): string => drafts[p] ?? (skill ? (files?.find((f) => f.path === p)?.text ?? "") : skillTemplate(name.trim()));

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) askClose();
      }}
      onOpenChangeComplete={(next) => {
        if (!next) then.current();
      }}
    >
      <ModalPanel title={title} size="lg" busy={pending} className="h-[min(40rem,calc(100vh-4rem))]">
        <form
          className="flex min-h-0 flex-1 flex-col"
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
        >
          <ModalBody className="min-h-0 flex-1">
            {skill ? null : (
              <Field label="Name" error={nameError ?? undefined}>
                <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="polish" spellCheck={false} autoComplete="off" />
              </Field>
            )}
            <div className="flex flex-col">
              <FieldRow label="Where">
                <ChoiceSelect label="Where" size="sm" value={workspaceId ?? ""} onChange={(v) => setWorkspaceId(v || null)} options={where} />
              </FieldRow>
              <FieldRow label="Agent apps">
                {/* One app a line, so the three never crowd the dialog's edge at any width. */}
                <div role="group" className="flex flex-col items-start gap-2">
                  {SKILL_HARNESSES.map((h) => (
                    <CheckRow
                      key={h}
                      label={CLI_LABELS[h]}
                      checked={choice[h]}
                      disabled={!canUntick(choice, h)}
                      onCheckedChange={(checked) => setChoice((cur) => ({ ...cur, [h]: checked }))}
                    />
                  ))}
                </div>
              </FieldRow>
            </div>
            {/* The files beside the editor from 40rem of the dialog, stacked under it. */}
            <div className="@container/skill flex min-h-0 flex-1 flex-col">
              {read.error && !loaded ? (
                <ReadFailure computer={link.environmentId} error={read.error} retry={read.retry} />
              ) : (
                <div className="grid min-h-0 flex-1 grid-cols-1 grid-rows-[auto_minmax(0,1fr)] gap-3 @[40rem]/skill:grid-cols-[12rem_minmax(0,1fr)] @[40rem]/skill:grid-rows-1">
                  {/* The files' own list, drawn from a sample while they are read. */}
                  <Region
                    loading={!files}
                    label="Loading files"
                    fill
                    bones={
                      <FileList
                        paths={SAMPLE_SKILL_FILES.map((path) => ({ path }))}
                        active={null}
                        onJump={STILL}
                      />
                    }
                  >
                    {files ? (
                      <FileList
                        paths={files.map((f) => ({ path: f.path, trailing: isBinary(f) ? sizeWords(fileBytes(f)) : undefined }))}
                        active={current?.path ?? null}
                        onJump={(key) => {
                          setPath(key);
                          if (files.some((f) => f.path === key && !isBinary(f))) setTextPath(key);
                        }}
                      />
                    ) : null}
                  </Region>
                  <div className="min-h-0">
                    {!files || !current ? (
                      // The editor's frame on its way: no words to draw, one block in its place.
                      <Bone data-editor-skeleton className="h-full w-full rounded-lg" />
                    ) : (
                      <>
                        {textFile ? (
                          <div data-editor-frame className={isBinary(current) ? "hidden" : "h-full"}>
                            <SkillEditor
                              path={textFile.path}
                              value={textOf(textFile.path)}
                              label={textFile.path}
                              onChange={(text) => setDrafts((cur) => ({ ...cur, [textFile.path]: text }))}
                            />
                          </div>
                        ) : null}
                        {isBinary(current) ? (
                          <p data-binary-line className="py-1 text-xs text-muted-foreground">
                            Binary file, {sizeWords(fileBytes(current))}
                          </p>
                        ) : null}
                      </>
                    )}
                  </div>
                </div>
              )}
            </div>
            <ErrorLine error={error} />
          </ModalBody>
          <DialogFooter onCancel={askClose} confirmLabel={skill ? "Save" : "Create"} pending={pending} disabled={!!skill && !loaded} />
        </form>
      </ModalPanel>
    </Dialog>
  );
}

/** The skill's files beside its editor: one row a path, a binary file's size at its end. */
function FileList({
  paths,
  active,
  onJump,
}: {
  paths: readonly { path: string; trailing?: string }[];
  active: string | null;
  onJump: (key: string) => void;
}) {
  return (
    <JumpList
      label="Files"
      groups={[
        {
          label: null,
          items: paths.map((f) => ({ key: f.path, label: <span className="truncate">{f.path}</span>, name: f.path, trailing: f.trailing })),
        },
      ]}
      active={active}
      onJump={onJump}
      // The rows' 8px padding hangs left of the column, so the names line up with the labels.
      className="-ms-2 max-h-32 min-h-0 @[40rem]/skill:max-h-none"
    />
  );
}
