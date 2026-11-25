// @vitest-environment jsdom
/**
 * A Work draft filed elsewhere (its filing control: a project, No project, Another job) keeps everything it held:
 * the text and connector chips in the field, files on disk and pasted bytes, its picks, and its id, by which Work's
 * chip store keeps what the message is about. Earlier builds lost drafts here.
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { ContextChip } from "@shared/work";
import { addContextChip, contextChipsOf, resetContextChips } from "../work/canvas/chips";
import { draftKeyOf, filedDraft, movedDraftKey, projectDrafts, sessionFromDraft, type DraftRecord } from "./projectDrafts";
import { newSession, type Attachment, type Session } from "./session";

const onDisk: Attachment = { id: "a1", name: "seat-map.xlsx", mimeType: "application/vnd.ms-excel", kind: "file", size: 9_000, path: "/jobs/purdue/seat-map.xlsx" };
const pasted: Attachment = { id: "a2", name: "Pasted image.png", mimeType: "image/png", kind: "image", size: 2_000, data: "iVBORw0K" };
const task: ContextChip = { kind: "task", label: "Count the patch cables", ref: { at: "lifeos", table: "tasks", id: "t1" } };

const record = (over: Partial<DraftRecord> = {}): DraftRecord => ({
  id: "d1",
  environmentId: "local",
  projectId: "p-lan",
  workspaceId: "w-purdue",
  cwd: "/jobs/purdue",
  harness: "claude",
  model: "claude-opus-5-5",
  modelSettings: {},
  runtimeMode: "supervised",
  threadType: "chat",
  threadRules: null,
  scope: "work",
  segments: [{ text: "Ask Sam for two switches " }, { chip: { token: "/linear", name: "linear" } }, { text: " by Friday" }],
  attachments: [],
  seenAt: 0,
  ...over,
});

const catalog = { projects: [{ id: "p-lan", environmentId: "local", linkId: null }, { id: "p-budget", environmentId: "local", linkId: null }] };
const none = () => false;

beforeEach(() => {
  localStorage.clear();
  projectDrafts.reload();
  resetContextChips();
});

describe("movedDraftKey", () => {
  const at = (records: Record<string, DraftRecord>, args: { fromKey: string; toScope: string; sent?: (id: string) => boolean }) =>
    movedDraftKey({ id: "d1", record: (k) => records[k], sent: args.sent ?? none, ...args });

  it("takes the new scope's key", () => {
    expect(at({}, { fromKey: "p-lan", toScope: "p-budget" })).toBe("p-budget");
    expect(at({}, { fromKey: "p-lan", toScope: "loose:w-purdue" })).toBe("loose:w-purdue");
  });

  it("keeps a start's own draft about its thing under the new scope", () => {
    expect(at({}, { fromKey: 'p-lan#about:{"at":"lifeos","id":"t1"}', toScope: "p-budget" })).toBe('p-budget#about:{"at":"lifeos","id":"t1"}');
  });

  it("never takes a key whose draft holds his words: the moved one gets its own, the other stays", () => {
    const other = record({ id: "d2", projectId: "p-budget", segments: [{ text: "Fill the travel lines" }] });
    expect(at({ "p-budget": other }, { fromKey: "p-lan", toScope: "p-budget" })).toBe("p-budget#draft:d1");
  });

  it("takes a key whose draft is empty, or already sent", () => {
    const empty = record({ id: "d2", segments: [{ text: "  " }] });
    expect(at({ "p-budget": empty }, { fromKey: "p-lan", toScope: "p-budget" })).toBe("p-budget");
    const sent = record({ id: "d3", segments: [{ text: "Fill the travel lines" }] });
    expect(at({ "p-budget": sent }, { fromKey: "p-lan", toScope: "p-budget", sent: (id) => id === "d3" })).toBe("p-budget");
  });
});

describe("a draft filed elsewhere", () => {
  it("keeps its text, connector chips, files, pasted bytes and context chips across a move", () => {
    projectDrafts.put("p-lan", { ...record(), attachments: [onDisk, pasted] });
    addContextChip("d1", task);
    const to = { environmentId: "local", projectId: "p-budget", workspaceId: "w-purdue", cwd: "/jobs/purdue" };
    const toKey = movedDraftKey({ fromKey: "p-lan", toScope: draftKeyOf(to, catalog), id: "d1", record: (k) => projectDrafts.get(k), sent: none });
    projectDrafts.move("p-lan", toKey);

    expect(projectDrafts.get("p-lan")).toBeUndefined();
    expect(projectDrafts.keyOfDraft("d1")).toBe("p-budget");
    const moved = projectDrafts.get("p-budget")!;
    expect(moved.id).toBe("d1");
    expect(moved.segments).toEqual(record().segments);
    expect(moved.attachments.map((a) => a.id)).toEqual(["a1", "a2"]);
    expect(moved.attachments.find((a) => a.id === "a2")?.data).toBe("iVBORw0K");
    // The chip store keys by the draft's id, which the move keeps.
    expect(contextChipsOf("d1")).toEqual([task]);

    // A relaunch reads the files on disk back; pasted bytes were this run's alone, as before.
    projectDrafts.flush();
    projectDrafts.reload();
    expect(projectDrafts.get("p-budget")?.segments).toEqual(record().segments);
    expect(projectDrafts.get("p-budget")?.attachments.map((a) => a.id)).toEqual(["a1"]);
  });

  it("replaces an empty draft at the new key, and leaves a draft that holds words where it was", () => {
    projectDrafts.put("p-lan", record());
    projectDrafts.put("p-budget", record({ id: "d2", projectId: "p-budget", segments: [{ text: "Fill the travel lines" }] }));
    const toKey = movedDraftKey({ fromKey: "p-lan", toScope: "p-budget", id: "d1", record: (k) => projectDrafts.get(k), sent: none });
    projectDrafts.move("p-lan", toKey);
    expect(projectDrafts.get("p-budget")?.id).toBe("d2");
    expect(projectDrafts.get("p-budget#draft:d1")?.segments).toEqual(record().segments);
  });

  it("a move to the key it holds changes nothing", () => {
    projectDrafts.put("p-lan", record());
    projectDrafts.move("p-lan", "p-lan");
    expect(projectDrafts.get("p-lan")?.id).toBe("d1");
  });

  it("files the session at its new place and keeps its id, type and his own picks", () => {
    const draft: Session = {
      ...sessionFromDraft(record(), null),
      threadType: "research",
      runtimeMode: "full-access",
      accessPicked: true,
      modelPicked: true,
      harness: "codex",
      model: "gpt-6.2-sol",
    };
    const filed = filedDraft(draft, { environmentId: "env_box", projectId: null, workspaceId: "w-cosmic", cwd: "/jobs/cosmic" });
    expect(filed).toMatchObject({
      id: "d1",
      environmentId: "env_box",
      projectId: null,
      workspaceId: "w-cosmic",
      cwd: "/jobs/cosmic",
      threadType: "research",
      runtimeMode: "full-access",
      harness: "codex",
      model: "gpt-6.2-sol",
    });
  });

  it("takes the new place's access when he did not pick one", () => {
    const draft = { ...newSession("local", "claude", "/jobs/purdue", "claude-opus-5-5"), id: "d1", runtimeMode: "full-access" as const };
    const filed = filedDraft(draft, { environmentId: "local", projectId: "p-budget", workspaceId: "w-purdue", cwd: "/jobs/purdue" });
    expect(filed.accessPicked).toBeUndefined();
    expect(filed.runtimeMode).not.toBe("full-access");
  });
});
