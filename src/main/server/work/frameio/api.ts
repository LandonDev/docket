import { frameioConfig } from './auth'

/**
 * Frame.io's V4 REST API, called directly (docs/agents/work-frameio.md, "The
 * API"): its SDKs declare no licence. Every path is under
 * `https://api.frame.io/v4`, answers `{ data }`, pages by an `after` cursor
 * in `links.next`, and fails as `{ errors: [{ detail, title }] }`. A 401
 * refreshes the token once; a 429 waits what it says, once.
 */

export interface FioUser {
  id: string
  name: string
  email?: string
}
export interface FioAccount {
  id: string
  display_name?: string
  name?: string
}
export interface FioWorkspace {
  id: string
  name: string
}
export interface FioProject {
  id: string
  name: string
  root_folder_id: string
  workspace_id: string
}
export interface FioLink {
  url?: string | null
  download_url?: string | null
  inline_url?: string | null
}
export interface FioFile {
  id: string
  name: string
  type: 'file'
  media_type?: string
  file_size?: number
  parent_id?: string
  project_id?: string
  status?: string
  created_at?: string
  media_links?: { original?: FioLink; high_quality?: FioLink; efficient?: FioLink; thumbnail?: FioLink }
}
export interface FioChild {
  id: string
  name: string
  type: 'file' | 'folder' | 'version_stack'
  media_type?: string
  parent_id?: string
}
export interface FioComment {
  id: string
  file_id: string
  text: string
  /** frames, or `HH:MM:SS:FF` when asked for as a timecode */
  timestamp?: number | string | null
  duration?: number | null
  annotation?: string | null
  anchor?: { x: number; y: number } | null
  completed_at?: string | null
  created_at?: string
  owner?: FioUser
  replies?: FioComment[]
}
export interface FioWebhook {
  id: string
  name: string
  url: string
  events: string[]
  secret?: string
  workspace_id?: string
}

export class FrameioError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message)
    this.name = 'FrameioError'
  }
}

type Query = Record<string, string | number | boolean | undefined>

/** An id as one path segment: Frame.io's are UUIDs, so anything else (a `..`, a `?`) is refused before it can reach another route. */
export function seg(id: string): string {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(id)) throw new Error(`${JSON.stringify(id).slice(0, 60)} is not a Frame.io id`)
  return id
}

export class FrameioApi {
  constructor(
    private readonly auth: {
      access(): Promise<string>
      refresh(): Promise<string | null>
    }
  ) {}

  /** One call's whole answer: `{ data, links }` for a list. */
  async raw<T>(method: string, path: string, o: { query?: Query; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
    const url = new URL(frameioConfig.api.replace(/\/$/, '') + path)
    for (const [k, v] of Object.entries(o.query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v))
    let token = await this.auth.access()
    for (let attempt = 0; ; attempt++) {
      const res = await frameioConfig.fetch(url, {
        method,
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(o.body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        ...(o.body !== undefined ? { body: JSON.stringify(o.body) } : {}),
        ...(o.signal ? { signal: o.signal } : {})
      })
      if (res.status === 401 && attempt === 0) {
        const fresh = await this.auth.refresh()
        if (fresh) {
          token = fresh
          continue
        }
      }
      if (res.status === 429 && attempt === 0) {
        const wait = Math.min(10, Number(res.headers.get('retry-after')) || 2)
        await new Promise((r) => setTimeout(r, wait * 1000))
        continue
      }
      if (res.status === 204) return undefined as T
      const body = (await res.json().catch(() => null)) as { errors?: Array<{ detail?: string; title?: string }> } | null
      if (!res.ok) {
        const e = body?.errors?.[0]
        throw new FrameioError(`Frame.io answered ${res.status}${e ? `: ${e.detail ?? e.title}` : ''}`, res.status)
      }
      return body as T
    }
  }

  async call<T>(method: string, path: string, o: { query?: Query; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
    const body = await this.raw<{ data?: T } | undefined>(method, path, o)
    return (body && typeof body === 'object' && 'data' in body ? body.data : body) as T
  }

  /** Every page of a list, up to `max` rows. `include` and the rest go again on every page: `links.next` carries only the cursor. */
  async list<T>(path: string, query: Query = {}, max = 2000, signal?: AbortSignal): Promise<T[]> {
    const out: T[] = []
    let after: string | undefined
    do {
      const page = await this.raw<{ data: T[]; links?: { next?: string | null } }>('GET', path, { query: { ...query, page_size: 100, after }, ...(signal ? { signal } : {}) })
      out.push(...(page?.data ?? []))
      const next = page?.links?.next
      after = next ? (new URL(next, frameioConfig.api).searchParams.get('after') ?? undefined) : undefined
    } while (after && out.length < max)
    return out
  }

  me = (): Promise<FioUser> => this.call('GET', '/me')
  accounts = (): Promise<FioAccount[]> => this.list('/accounts')
  workspaces = (a: string): Promise<FioWorkspace[]> => this.list(`/accounts/${seg(a)}/workspaces`)
  projects = (a: string, ws: string): Promise<FioProject[]> => this.list(`/accounts/${seg(a)}/workspaces/${seg(ws)}/projects`)
  project = (a: string, p: string): Promise<FioProject> => this.call('GET', `/accounts/${seg(a)}/projects/${seg(p)}`)
  children = (a: string, folder: string): Promise<FioChild[]> => this.list(`/accounts/${seg(a)}/folders/${seg(folder)}/children`)
  stackChildren = (a: string, stack: string): Promise<FioFile[]> => this.list(`/accounts/${seg(a)}/version_stacks/${seg(stack)}/children`)
  isStack = async (a: string, id: string): Promise<boolean> =>
    this.call('GET', `/accounts/${seg(a)}/version_stacks/${seg(id)}`).then(
      () => true,
      (err) => {
        if (err instanceof FrameioError && err.status === 404) return false
        throw err
      }
    )
  file = (a: string, id: string, include?: string, signal?: AbortSignal): Promise<FioFile> => this.call('GET', `/accounts/${seg(a)}/files/${seg(id)}`, { query: { include }, ...(signal ? { signal } : {}) })
  comments = (a: string, file: string, signal?: AbortSignal): Promise<FioComment[]> => this.list(`/accounts/${seg(a)}/files/${seg(file)}/comments`, { include: 'owner,replies' }, 2000, signal)
  comment = (a: string, id: string): Promise<FioComment> => this.call('GET', `/accounts/${seg(a)}/comments/${seg(id)}`, { query: { include: 'owner' } })
  createComment = (a: string, file: string, data: Record<string, unknown>): Promise<FioComment> => this.call('POST', `/accounts/${seg(a)}/files/${seg(file)}/comments`, { body: { data } })
  localUpload = (a: string, folder: string, name: string, size: number): Promise<FioFile & { upload_urls: Array<{ size: number; url: string }> }> =>
    this.call('POST', `/accounts/${seg(a)}/folders/${seg(folder)}/files/local_upload`, { body: { data: { name, file_size: size } } })
  uploadStatus = (a: string, file: string): Promise<{ upload_complete?: boolean; upload_failed?: boolean }> => this.call('GET', `/accounts/${seg(a)}/files/${seg(file)}/status`)
  moveFile = (a: string, file: string, parent: string): Promise<FioFile> => this.call('PATCH', `/accounts/${seg(a)}/files/${seg(file)}/move`, { body: { data: { parent_id: parent } } })
  makeStack = (a: string, folder: string, fileIds: string[]): Promise<{ id: string }> => this.call('POST', `/accounts/${seg(a)}/folders/${seg(folder)}/version_stacks`, { body: { data: { file_ids: fileIds } } })
  webhooks = (a: string, ws: string): Promise<FioWebhook[]> => this.list(`/accounts/${seg(a)}/workspaces/${seg(ws)}/webhooks`)
  createWebhook = (a: string, ws: string, data: { name: string; url: string; events: string[] }): Promise<FioWebhook> => this.call('POST', `/accounts/${seg(a)}/workspaces/${seg(ws)}/webhooks`, { body: { data } })
  deleteWebhook = (a: string, id: string): Promise<void> => this.call('DELETE', `/accounts/${seg(a)}/webhooks/${seg(id)}`)
}
