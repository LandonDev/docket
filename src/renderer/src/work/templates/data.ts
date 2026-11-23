import { useCallback, useEffect, useState } from "react";
import type { TemplateRemoved, TemplatesList } from "@shared/contract-work-templates";
import type { FolderRef } from "@shared/work/files";
import type { CanvasSource } from "@shared/work/canvas";
import { dayOf, type Template, type TemplateMade } from "@shared/work/templates";
import { registry } from "../../lib/connection";
import { refusalWords } from "../../lib/settingsHome";

/**
 * A workspace's shelf from its host (docs/agents/work-templates.md), kept
 * live by the `work.templates` push for that workspace or for every one
 * (null, a template for all jobs changed), and the verbs the screens send.
 * Every verb goes to the workspace's own host; a refusal comes back in the
 * host's words.
 */

export type Load<T> = { status: "loading" } | { status: "ready"; value: T } | { status: "error"; error: string };

export function useTemplates(env: string, workspaceId: string): [Load<TemplatesList>, () => void] {
  const [state, setState] = useState<Load<TemplatesList>>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const link = registry.linkOf(env);
    let live = true;
    // Several pushes ask in a row: only the newest answer is shown.
    let asked = 0;
    const fetch = () => {
      const mine = ++asked;
      link.request<TemplatesList>("work.templates.list", { workspaceId }).then(
        (r) => live && mine === asked && setState({ status: "ready", value: r }),
        (err: unknown) => live && mine === asked && setState({ status: "error", error: refusalWords(err) || "The host did not answer" }),
      );
    };
    fetch();
    const off = link.onPush((push) => {
      if (push.push === "work.templates" && (push.workspaceId === null || push.workspaceId === workspaceId)) fetch();
    });
    return () => {
      live = false;
      off();
    };
  }, [env, workspaceId, attempt]);
  const retry = useCallback(() => {
    setState({ status: "loading" });
    setAttempt((n) => n + 1);
  }, []);
  return [state, retry];
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

/** The fields a file would ask for as a template, read before it is saved. */
export const fieldsOfFile = (env: string, workspaceId: string, source: CanvasSource): Promise<string[]> =>
  ask<{ fields: string[] }>(env, "work.templates.fields", { workspaceId, source }, "The host did not read the file").then((r) => r.fields);

/** Puts files Trash took back where they were (a remove's Undo). */
export const restoreFiles = (env: string, workspaceId: string, ids: readonly string[]): Promise<unknown> =>
  ask(env, "work.files.restore", { workspaceId, ids, op: crypto.randomUUID() }, "The host did not put it back");
