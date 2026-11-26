// Static renders of the Add key… dialog (bun run ui:preview src/renderer/src/aliax/views/AddKeyDialog.tsx#AddKeyDialog).
const pending = () => new Promise(() => {})
const props = { open: true, onOpenChange: 'fn', serviceName: 'Meta', onAdded: 'fn' }

// A request that rejects with a store's own text: the line under Key says the one plain line instead.
const refused = () => Promise.reject(new Error("EACCES: permission denied, open '/Users/me/.aliax/keys.json'"))
const typeAndAdd = async (): Promise<void> => {
  const key = document.querySelector<HTMLInputElement>('input[type="password"]')
  if (!key) throw new Error('Missing preview field: Key')
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set?.call(key, 'LLM_1607_abcd')
  key.dispatchEvent(new window.Event('input', { bubbles: true }))
  await new Promise((r) => setTimeout(r, 0))
  const add = [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === 'Add')
  if (!add) throw new Error('Missing preview control: Add')
  add.click()
  await new Promise((r) => setTimeout(r, 50))
}

export default [
  { name: 'Empty: Add waits for a key', props: { ...props, submit: pending } },
  { name: 'A save that failed', props: { ...props, submit: refused }, prepare: typeAndAdd }
]
