import { dialogErrorWords } from '../lib/dialogErrorWords'
import { useEffect, useState } from 'react'
import type { ThreadResource } from '@server/shared/contract-resources'
import {
  KIND_LABEL,
  archiveThread,
  hostName,
  isRemovable,
  readThreadResources,
  removalClause,
  removeThreadResources,
  rowState,
  useThreadResources
} from '../lib/threadResources'
import { LoadingLine } from '../surfaces/SurfaceSkeleton'
import { DialogFooter, ErrorLine } from './ConfirmDialog'
import { CheckRow } from './DialogField'
import { Tip } from '../components/tip'
import { Modal, ModalBody, useModalClose } from './Modal'
import { Button } from '../components/ui/button'
import { useHostHeld } from '../lib/connection/degraded'
import { useLinkMay } from '../lib/linkMay'
import { registry } from '../lib/connection/registry'
import { sessionStore } from '../lib/tcserver/store'

/**
 * Thread resources (docs/box.md "Thread resources"): the thread menu's
 * "Resources…" removal form, one checkbox per worktree, simulator or dev
 * instance the thread created, and one red Remove N; and the archive dialog
 * that offers to remove them with the thread. Both read the same store
 * (lib/threadResources.ts), so a removal's outcome lands as the host reports
 * it. Dev servers are not here: Activity and the dev servers pane list and
 * stop them.
 */

/** One row of the form: its kind, its label (the identifier on hover), and
 *  where it lives with its state, muted. A row its host is still removing
 *  cannot be picked again. */
function ResourceCheck({ row, checked, disabled, onChange }: { row: ThreadResource; checked: boolean; disabled: boolean; onChange: (on: boolean) => void }) {
  const state = rowState(row)
  return (
    <CheckRow
      checked={checked}
      disabled={disabled}
      onCheckedChange={onChange}
      label={
        <span className="flex min-w-0 items-baseline gap-2" data-resource={row.id}>
          <span className="shrink-0 text-muted-foreground">{KIND_LABEL[row.kind]}</span>
          <Tip label={row.identifier}>
            <span className="min-w-0 truncate font-mono text-xs">{row.label}</span>
          </Tip>
          <span className="shrink-0 text-xs text-muted-foreground">{hostName(row.environmentId)}</span>
          {state ? <span className="min-w-0 truncate text-xs text-muted-foreground">{state}</span> : null}
        </span>
      }
    />
  )
}

/** "The box did not answer": a failed read in the host's name, never its transport text. */
function didNotAnswer(environmentId: string | undefined): string {
  const name = environmentId && registry.environment(environmentId) ? hostName(environmentId) : 'the host'
  return `${name.charAt(0).toUpperCase()}${name.slice(1)} did not answer`
}

/** The thread menu's "Resources…": pick what goes, then Remove N. */
export function ThreadResourcesDialog({ sessionId, title, onClose }: { sessionId: string; title: string; onClose: () => void }) {
  const [pending, setPending] = useState(false)
  return (
    <Modal onClose={onClose} busy={pending} title="Resources" description={title} size="sm">
      <ResourcesForm sessionId={sessionId} onClose={onClose} pending={pending} setPending={setPending} />
    </Modal>
  )
}

function ResourcesForm({
  sessionId,
  onClose,
  pending,
  setPending
}: {
  sessionId: string
  onClose: () => void
  pending: boolean
  setPending: (on: boolean) => void
}) {
  const close = useModalClose()
  const rows = useThreadResources(sessionId).filter(isRemovable)
  const [loaded, setLoaded] = useState(false)
  // The host did not answer the read: said as such with Retry, never "Nothing left" (edges-26).
  const [readFailed, setReadFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const environmentId = sessionStore.environmentOf(sessionId)
  const held = useHostHeld(environmentId)
  // A key that may not remove gets the list to read and no Remove (D5).
  const mayRemove = useLinkMay(environmentId ?? '', 'resources.remove')
  const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set())
  const [removed, setRemoved] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    setReadFailed(false)
    void readThreadResources(sessionId).then(
      () => live && setLoaded(true),
      () => {
        if (!live) return
        setReadFailed(true)
        setLoaded(true)
      }
    )
    return () => {
      live = false
    }
  }, [sessionId, attempt])

  // A removal that leaves nothing behind closes the form: its work is done.
  const empty = rows.length === 0
  useEffect(() => {
    if (removed && empty) close ? close(onClose) : onClose()
  }, [removed, empty]) // eslint-disable-line react-hooks/exhaustive-deps

  const waiting = (row: ThreadResource) => !!row.removeRequestedAt && !row.removedAt
  const chosen = rows.filter((r) => picked.has(r.id) && !waiting(r)).map((r) => r.id)
  const toggle = (id: string, on: boolean) =>
    setPicked((prev) => {
      const next = new Set(prev)
      if (on) next.add(id)
      else next.delete(id)
      return next
    })

  const confirm = async () => {
    if (pending || !chosen.length) return
    setPending(true)
    setError(null)
    try {
      const results = await removeThreadResources(sessionId, chosen)
      const failed = results.filter((r) => r.outcome === 'failed')
      if (failed.length) setError(failed.map((f) => f.note ?? 'failed').join('\n'))
      setPicked(new Set(failed.map((f) => f.id)))
      setRemoved(true)
    } catch (err) {
      setError(dialogErrorWords(err))
    } finally {
      setPending(false)
    }
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        void confirm()
      }}
    >
      <ModalBody className="gap-2" data-thread-resources={sessionId}>
        {empty && !loaded ? (
          <LoadingLine label="Loading…" />
        ) : empty && readFailed ? (
          <div className="flex items-center gap-2 py-1 text-[13px] text-destructive">
            <span className="min-w-0 flex-1">{didNotAnswer(environmentId)}</span>
            <Button variant="ghost" size="xs" onClick={() => setAttempt((n) => n + 1)}>
              Retry
            </Button>
          </div>
        ) : empty ? (
          <p className="py-1 text-[13px] text-muted-foreground">Nothing left to remove.</p>
        ) : (
          <div className="flex flex-col">
            {rows.map((row) => (
              <ResourceCheck
                key={row.id}
                row={row}
                checked={picked.has(row.id) && !waiting(row)}
                disabled={pending || waiting(row)}
                onChange={(on) => toggle(row.id, on)}
              />
            ))}
          </div>
        )}
        <ErrorLine error={error} />
      </ModalBody>
      {/* No Remove while nothing is listed; held, its reason the host's state, while the host is away. */}
      <DialogFooter
        onCancel={onClose}
        confirmLabel={empty || !mayRemove ? undefined : chosen.length ? `Remove ${chosen.length}` : 'Remove'}
        danger
        pending={pending}
        disabled={!chosen.length || !!held}
        note={empty ? undefined : (held ?? undefined)}
      />
    </form>
  )
}

type ArchiveProps = {
  sessionId: string
  title: string
  resources: readonly ThreadResource[]
  onCancel: () => void
  onArchived: () => void
}

/** Archive, offering to remove the thread's resources with it (the box is on by default). */
export function ArchiveThreadDialog(props: ArchiveProps) {
  const [pending, setPending] = useState(false)
  return (
    <Modal onClose={props.onCancel} busy={pending} title={`Archive ${props.title}?`} size="sm">
      <ArchiveBody {...props} pending={pending} setPending={setPending} />
    </Modal>
  )
}

function ArchiveBody({
  sessionId,
  resources,
  onCancel,
  onArchived,
  pending,
  setPending
}: ArchiveProps & { pending: boolean; setPending: (on: boolean) => void }) {
  const close = useModalClose()
  const [remove, setRemove] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const confirm = async () => {
    setPending(true)
    setError(null)
    try {
      await archiveThread(sessionId, { removeResources: remove })
      setPending(false)
      if (close) close(onArchived)
      else onArchived()
    } catch (err) {
      setError(dialogErrorWords(err))
      setPending(false)
    }
  }
  return (
    <>
      {resources.length ? (
        <div className="flex flex-col gap-1 px-5 py-4">
          <CheckRow label={removalClause(resources)} checked={remove} disabled={pending} onCheckedChange={setRemove} />
          <div className="flex flex-col gap-0.5 pl-6 text-xs text-muted-foreground" data-archive-resources>
            {resources.map((r) => (
              <div key={r.id} className="flex min-w-0 gap-2">
                <span className="shrink-0">{KIND_LABEL[r.kind]}</span>
                <Tip label={r.identifier}>
                  <span className="min-w-0 truncate font-mono">{r.label}</span>
                </Tip>
              </div>
            ))}
          </div>
          <ErrorLine error={error} />
        </div>
      ) : error ? (
        <div className="px-5 py-4">
          <ErrorLine error={error} />
        </div>
      ) : null}
      <DialogFooter onCancel={onCancel} onConfirm={() => void confirm()} confirmLabel="Archive" danger={remove && resources.length > 0} pending={pending} />
    </>
  )
}
