import { useEffect, useMemo } from "react";
import type { TemplateFields, TemplateRemoved, TemplatesList } from "@shared/contract-work-templates";
import type { FolderRef } from "@shared/work/files";
import type { CanvasSource } from "@shared/work/canvas";
import { dayOf, type Template, type TemplateMade } from "@shared/work/templates";
import { registry } from "../../lib/connection";
import { useHostRead } from "../../lib/connection/hostRead";
import { refusalWords } from "../../lib/settingsHome";

/**
 * A workspace's shelf from its host (docs/agents/work-templates.md), read the
 * way DESIGN.md says a page reads a host (`useHostRead`): it waits for the
 * socket, asks again on every new socket until it has answered, and a refresh
 * that fails keeps the shelf on screen. The `work.templates` push for this
 * workspace or for every one (null: a template for all jobs changed) asks
 * again, keeping what is shown. Then the verbs the screens send: every one
 * goes to the workspace's own host, and a refusal comes back in its words.
 */

export type Load<T> = { status: "loading" } | { status: "ready"; value: T } | { status: "error"; error: string };

/** What a host read says as the screens show it: the shelf once it has one, kept through a failed refresh. */
export function loadOf<T>(read: { value: T | undefined; error: string | null }): Load<T> {
  if (read.value !== undefined) return { status: "ready", value: read.value };
  return read.error !== null ? { status: "error", error: read.error } : { status: "loading" };
}

export function useTemplates(env: string, workspaceId: string): [Load<TemplatesList>, () => void] {
  const link = useMemo(() => {
    try {
      return registry.linkOf(env);
    } catch {
      return null;
    }
  }, [env]);
  const read = useHostRead<TemplatesList>(
    link,
    () =>
      link!.request<TemplatesList>("work.templates.list", { workspaceId }).catch((err: unknown) => {
        throw new Error(refusalWords(err) || "The host did not answer");
      }),
    workspaceId,
  );
  const { retry } = read;
  useEffect(() => {
    if (!link) return;
    return link.onPush((push) => {
      if (push.push === "work.templates" && (push.workspaceId === null || push.workspaceId === workspaceId)) retry();
    });
  }, [link, workspaceId, retry]);
  return [loadOf(read), retry];
}

async function ask<T>(env: string, method: string, params: object, failed: string): Promise<T> {
  try {
    return await registry.linkOf(env).request<T>(method, params);
  } catch (err) {
    throw new Error(refusalWords(err) || failed);
  }
}

/** A new file from the template, its fields filled; the window's own day fills Date. */
export const makeFrom = (env: string, workspaceId: string, template: string, opts: { into?: FolderRef; fields?: Record<string, string> } = {}): Promise<TemplateMade> =>
  ask(env, "work.templates.make", { workspaceId, template, ...(opts.into ? { into: opts.into } : {}), ...(opts.fields ? { fields: opts.fields } : {}), today: dayOf(new Date()) }, "The host did not make the file");

export const saveTemplate = (env: string, workspaceId: string, source: CanvasSource, opts: { name?: string; everywhere?: boolean } = {}): Promise<Template> =>
  ask(env, "work.templates.save", { workspaceId, source, ...(opts.name ? { name: opts.name } : {}), ...(opts.everywhere ? { everywhere: true } : {}) }, "The host did not save it");

export const renameTemplate = (env: string, workspaceId: string, template: string, name: string): Promise<Template> =>
  ask(env, "work.templates.rename", { workspaceId, template, name }, "The host did not rename it");

export const moveTemplate = (env: string, workspaceId: string, template: string, everywhere: boolean): Promise<Template> =>
  ask(env, "work.templates.move", { workspaceId, template, everywhere }, "The host did not move it");

export const removeTemplate = (env: string, workspaceId: string, template: string, confirmed?: boolean): Promise<TemplateRemoved> =>
  ask(env, "work.templates.remove", { workspaceId, template, ...(confirmed ? { confirmed: true } : {}) }, "The host did not remove it");

/** Every starter hidden in this workspace shown again, or (`template`) that one alone: the undo of one Hide. */
export const unhideStarters = (env: string, workspaceId: string, template?: string): Promise<object> =>
  ask(env, "work.templates.unhide", { workspaceId, ...(template ? { template } : {}) }, "The host did not answer");

/** The fields a file would ask for as a template, read before it is saved; `later`: known only from the save's answer (our own sheet, kept as Excel). */
export const fieldsOfFile = (env: string, workspaceId: string, source: CanvasSource): Promise<TemplateFields> =>
  ask<TemplateFields>(env, "work.templates.fields", { workspaceId, source }, "The host did not read the file");

/** Puts files Trash took back where they were (a remove's Undo). */
export const restoreFiles = (env: string, workspaceId: string, ids: readonly string[]): Promise<unknown> =>
  ask(env, "work.files.restore", { workspaceId, ids, op: crypto.randomUUID() }, "The host did not put it back");
