import { parseKey } from 'work-kit/lifeos/projects'
import { mentionExcerpt, type MentionReach } from '@shared/work'
import type { MentionSource } from '../modules'

/**
 * A project's card for the composer's `@` (docs/agents/work-canvas.md
 * "Mentions"): a task of a project, found by its key and by nothing else
 * (`@PUR-41`, any case). A task is found by its words in the Tasks group
 * (lifeos/mentions.ts), so no task is ever offered twice; the key is how he
 * names the one he sees on a project's page. The host reads as the owner,
 * so the reach's sectors are the fence here: a key of a sector the thread
 * may not read is not asked for, and a row of another is dropped whatever
 * LifeOS answered.
 */

type Task = { _id: string; key?: string; title: string; description?: string; sector?: string; projectId?: string; dueAt?: number }
type Project = { _id: string; name: string }

const reads = (reach: MentionReach, sector: string | undefined): boolean => reach.sectors === 'all' || (!!sector && reach.sectors.includes(sector))

export const cardMention: MentionSource = {
  kind: 'card',
  lifeos: true,
  async search(text, reach, ctx) {
    const asked = parseKey(text)
    if (!asked || !reads(reach, asked.sector)) return []
    const owner = ctx.lifeos.owner()
    const [task] = (await owner.query<Task[]>('tasks:byKeys', { keys: [asked.key] })) ?? []
    // A card is a project's task: one in no project is a task, found by its words.
    if (!task?.projectId || !reads(reach, task.sector)) return []
    const projects = (await owner.query<Project[]>('projects:list', { sector: task.sector }).catch(() => null)) ?? []
    const project = projects.find((p) => p._id === task.projectId)?.name
    return [
      {
        chip: { kind: 'card', label: `${task.key ?? asked.key} ${task.title}`.slice(0, 500), ref: { at: 'lifeos', table: 'tasks', id: task._id }, excerpt: mentionExcerpt(task.description) },
        ...(project ? { detail: project } : {}),
        ...(task.dueAt !== undefined ? { at: task.dueAt } : {})
      }
    ]
  }
}
