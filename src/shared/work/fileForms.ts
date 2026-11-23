/**
 * The forms a new file may take on disk (docs/agents/work-files.md "New"): its extension, lower case, no dot.
 * A place decides the form (the workspace's folder keeps a document as `.tcdoc`, a Teams library as `.docx`);
 * a maker (work/files/hooks.ts `registerFileMaker`) says which of them it writes and its editor then edits in
 * place. Google's and LifeOS's own types are made by their places, not written as files, so they are not forms.
 */
export const FILE_FORMS = ['tcdoc', 'tcsheet', 'docx', 'xlsx', 'pptx', 'md', 'txt'] as const
export type FileForm = (typeof FILE_FORMS)[number]
export const isFileForm = (value: string): value is FileForm => (FILE_FORMS as readonly string[]).includes(value)
