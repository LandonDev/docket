import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { WorkCtx } from '../../modules'
import type { WorkspaceRow } from '../../files/policy'
import { makeFromTemplate } from '../../templates/api'
import { questionsOfDocument, paragraphsOfMarkdown, type DocumentForm } from './document'
import { markdownOfFile } from './read'

/**
 * A Microsoft form from a template (docs/agents/work-msforms.md "The makers"): a form template is a Word document
 * in the job's Templates written in the document grammar (document.ts) with `{{fields}}`. No new template kind:
 * `makeFromTemplate` fills a copy in a scratch folder inside the job's own folder, the document maker reads it, and
 * the copy and its folder go whatever happens.
 */

export const NOT_A_DOCUMENT_TEMPLATE = 'A form template is a Word document in the job’s Templates, written as numbered questions.'

/** The scratch folder a template is filled in: hidden, in the job's own folder, one a make. */
export const scratchFolderOf = (workspace: Pick<WorkspaceRow, 'path'>): string => join(workspace.path, `.msform-template-${randomUUID()}`)

export async function questionsOfTemplate(ctx: WorkCtx, workspace: WorkspaceRow, template: string, fields: Readonly<Record<string, string>> = {}): Promise<DocumentForm & { unfilled: string[] }> {
  const dir = scratchFolderOf(workspace)
  try {
    const made = await makeFromTemplate(ctx, { workspaceId: workspace.id, template, fields, into: { at: 'file', host: ctx.host, path: dir } })
    if (made.kind !== 'document' || made.source.at !== 'file') throw new Error(NOT_A_DOCUMENT_TEMPLATE)
    const form = questionsOfDocument(paragraphsOfMarkdown(await markdownOfFile(made.source.path)))
    return { ...form, ...(form.title ? {} : { title: made.title.slice(0, 90) }), unfilled: made.unfilled }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
