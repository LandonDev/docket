import assert from 'node:assert/strict'
import { networkInterfaces } from 'node:os'
import { join } from 'node:path'
import type { AdmissionState } from '../../../src/shared/contract-admission'
import type { AwaySnapshot } from '../../../src/shared/contract-away'
import type { RemotePairing, RemoteStatus, SavedEnvironment } from '../../../src/shared/contract-remote'
import { journey, step } from '../lib/record'
import { relay } from '../lib/relay'
import { DIALOG, enterField, settings } from '../lib/settings'
import type { Instance, Pair } from '../lib/shape'
import type { Window } from '../lib/window'

const WAIT = 15_000
const DEVICE = 'Settings journey device'
const MANAGER = 'Changed from a computer that manages box.'
const COMPUTER = '[data-app-settings] [data-computer-line="open"]'
const CODE = DIALOG + ' [data-pairing-code]'
const AWAY = '[data-setting="away.work"] [role="switch"]'
const RAIL_AWAY = '[data-menu-id="away"]'
const PRIVATE_IP = /^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/
const row = (id: string) => '[data-setting=' + JSON.stringify(id) + ']'
const workSwitch = (id: string) => '[data-setting="work.on"] [data-work-on=' + JSON.stringify(id) + '] [role="switch"]'
const pairingList = (pair: Pair, inst: Instance) => pair.rpc<RemotePairing[]>(inst, 'remote.pairings.list')
const workOn = async (pair: Pair, inst: Instance) => (await pair.rpc<{ enabled: boolean }>(inst, 'work.get')).enabled

async function openBox(page: Window): Promise<void> {
  await settings(page, 'box')
  await page.until('the box Settings page to show its connection', WAIT, () => page.eval(
    '!!document.querySelector(' + JSON.stringify(COMPUTER) + ')'
  ))
}

/** Poll the instance itself and report its last answer if the write never lands. */
async function expectRead<T>(page: Window, name: string, read: () => Promise<T>, want: T): Promise<void> {
  let actual: T | undefined
  try {
    await page.until(name, WAIT, async () => {
      actual = await read()
      return actual === want
    })
  } catch (error) {
    if (actual !== undefined && actual !== want) assert.deepEqual(actual, want, name)
    throw error
  }
}

async function commit(page: Window, setting: string, value: number): Promise<void> {
  await enterField(page, row(setting) + ' input', String(value))
  await page.key('Enter')
}

async function openWithKey(pair: Pair, key: string, admin: boolean): Promise<void> {
  const saved = await pair.rpc<SavedEnvironment>(pair.win, 'remote.environments.add', {
    url: 'http://127.0.0.1:' + pair.box.remote,
    key
  })
  assert.equal(saved.id, pair.box.host)
  assert.ok(saved.keyId, 'the saved box credential has no key id')
  assert.equal(saved.caps.includes('admin'), admin)
  // Reopen the built window's renderer so it starts with the saved credential, as on a normal launch.
  const { page } = pair
  await page.reload()
  const host = JSON.stringify(pair.box.host)
  await page.until('the saved box key to reconnect', WAIT, () => page.eval(
    `(() => {
      const status = window.__docket?.registry.statusOf(${host});
      return status?.transport === 'open' && status.lastHello?.key?.id === ${JSON.stringify(saved.keyId)} &&
        status.lastHello.caps.includes('admin') === ${admin};
    })()`
  ))
}

export default journey({
  id: 'J-computers',
  title: 'Change Settings from a desktop linked to the box',
  tier: 1,
  shapes: ['A'],
  continueOnFailure: true,
  steps: [
    step('Threads settings change only on the box', async ({ pair }) => {
      const { page, box, win } = pair
      const cap = (inst: Instance) => pair.rpc<AdmissionState>(inst, 'admission.get')
      const stuck = async (inst: Instance) => (await pair.rpc<RemoteStatus>(inst, 'remote.status')).stuckMinutes
      const [desktopCap, desktopMinutes, boxCap, boxMinutes] = await Promise.all([cap(win), stuck(win), cap(box), stuck(box)])
      const threads = boxCap.cap === 7 ? 8 : 7
      const minutes = boxMinutes === 17 ? 18 : 17
      await openBox(page)
      await commit(page, 'pc.atOnce', threads)
      await expectRead(page, 'box admission.get cap', async () => (await cap(box)).cap, threads)
      await commit(page, 'pc.stuck', minutes)
      await expectRead(page, 'box remote.status stuckMinutes', () => stuck(box), minutes)
      const [desktopAfter, minutesAfter] = await Promise.all([cap(win), stuck(win)])
      assert.deepEqual({ cap: desktopAfter.cap, pinned: desktopAfter.pinned, minutes: minutesAfter },
        { cap: desktopCap.cap, pinned: desktopCap.pinned, minutes: desktopMinutes }, 'desktop thread settings changed')
    }),
    step('Add makes a device sign-in link on the box alone', async ({ pair }) => {
      const { page, box, win } = pair
      const address = Object.values(networkInterfaces()).flat().find(ip =>
        ip?.family === 'IPv4' && !ip.internal && PRIVATE_IP.test(ip.address)
      )?.address
      assert.ok(address, 'The test box has no private IPv4 address for a device sign-in link')
      const hop = await relay(address, box.remote)
      pair.trackPort(hop.port)
      pair.later(() => hop.stop())
      const origin = 'http://' + address + ':' + hop.port
      await pair.rpc(box, 'remote.settings.set', { publicOrigin: origin })
      const hello = await fetch(origin + '/api/hello', { signal: AbortSignal.timeout(5000), redirect: 'error' })
      assert.ok(hello.ok, 'the device link address did not reach the box')
      assert.equal((await hello.json() as { environmentId: string }).environmentId, box.host)
      assert.deepEqual(await pairingList(pair, box), [], 'the fresh box already had a pairing')
      await openBox(page)
      await page.clickOn(row('pc.signIns') + ' ' + row('pc.add'), 'Add…')
      await enterField(page, DIALOG + ' input[placeholder="iPhone"]', DEVICE)
      await page.press('button', 'Make the link')
      await page.until('the device sign-in code', WAIT, () => page.centre(CODE))
      const made = await page.eval<boolean>(`(() => {
        const dialog = document.querySelector(${JSON.stringify(DIALOG)});
        const text = dialog.querySelector('[data-pairing-code]').textContent.trim();
        const expected = ${JSON.stringify(origin + '/pair#')} + text;
        return /^[A-Z0-9]{5}-[A-Z0-9]{5}$/.test(text) &&
          dialog.querySelector('[data-sign-in-link]')?.getAttribute('data-sign-in-link') === expected;
      })()`)
      await page.clickOn(DIALOG + ' button', 'Done')
      assert.ok(made, 'the dialog did not show a sign-in link at the box address with its code')
      const [boxLinks, desktopLinks] = await Promise.all([pairingList(pair, box), pairingList(pair, win)])
      assert.deepEqual(boxLinks.map(({ name }) => name), [DEVICE], 'unexpected box pairings')
      assert.deepEqual(desktopLinks.map(({ name }) => name), [], 'unexpected desktop pairings')
    }),
    step('An operate-only key sees thread settings as words and who can change them', async ({ pair, folder }) => {
      const { page, box } = pair
      const { cap } = await pair.rpc<AdmissionState>(box, 'admission.get')
      const { token: owner } = await pair.mint('owner', 'Settings journey restoration')
      const { token: operator } = await pair.rpc<{ token: string }>(box, 'remote.keys.create', {
        name: 'Settings journey operator', audience: 'client', caps: ['operate']
      })
      try {
        await openWithKey(pair, operator, false)
        await openBox(page)
        await page.until('the read-only Threads at once row', WAIT, () => page.eval('!!document.querySelector(' + JSON.stringify(row('pc.atOnce')) + ')'))
        await page.shot(join(folder, 'operate-only.png'))
        const view = await page.eval<{ managed: string[]; rows: { words: string; editable: boolean }[] }>(`(() => {
          const page = document.querySelector('[data-app-settings]');
          return {
            managed: [...page.querySelectorAll('[data-managed]')].map(line => line.innerText.trim()),
            rows: ['pc.atOnce', 'pc.stuck'].map(id => {
              const row = page.querySelector('[data-setting="' + id + '"]');
              return {
                words: row?.innerText.trim() ?? '',
                editable: !!row?.querySelector('input, select, textarea, [role="switch"], [role="spinbutton"]')
              };
            })
          };
        })()`)
        assert.deepEqual(view.managed, [MANAGER], 'expected one line saying who can change settings')
        assert.ok(view.rows[0]?.words.includes('Threads at once'), 'Threads at once is missing')
        assert.ok(view.rows[0]?.words.split('\n').some(line => line.trim() === String(cap)), 'Threads at once did not show the box cap as text')
        assert.ok(view.rows[1]?.words.includes('Tell me a thread is stuck after'), 'Tell me a thread is stuck after is missing')
        assert.ok(view.rows[1]?.words.split('\n').some(line => line.trim() === 'Hidden'), 'the admin-only stuck time did not show Hidden')
        assert.deepEqual(view.rows.map(({ editable }) => editable), [false, false], 'an operate-only key has a field or switch')
      } finally {
        await openWithKey(pair, owner, true)
      }
    }),
    step('Away for Work agrees on the page, the rail and the box', async ({ pair }) => {
      const { page, box } = pair
      const read = async () => (await pair.rpc<AwaySnapshot>(box, 'away.get')).state
      assert.equal((await read()).work, false, 'Work threads must start with Away off on the box')
      await settings(page, 'Away')
      await page.clickOn(AWAY + '[aria-checked="false"]')
      await expectRead(page, 'the Work threads switch to show on', () => page.eval(
        'document.querySelector(' + JSON.stringify(AWAY) + ')?.getAttribute("aria-checked")'
      ), 'true')
      await page.press('button', 'Back')
      await expectRead(page, 'Away for Work in the rail', () => page.eval(
        'document.querySelector(' + JSON.stringify(RAIL_AWAY) + ')?.innerText.trim()'
      ), 'Away for Work')
      await expectRead(page, 'box away.get work', async () => (await read()).work, true)
    }),
    step('end: The Work confirmation turns off only the desktop', async ({ pair }) => {
      const { page, box, win } = pair
      const read = () => Promise.all([workOn(pair, win), workOn(pair, box)])
      assert.deepEqual(await read(), [true, true], 'both computers must start with Work on')
      await settings(page, 'Setup')
      for (const id of ['local', box.host]) {
        await page.until('Work on for ' + id, WAIT, () => page.centre(workSwitch(id) + '[aria-checked="true"]'))
      }
      await page.clickOn(workSwitch('local'))
      const confirm = '[role="alertdialog"]'
      await page.until('the Work confirmation for this computer', WAIT, () => page.eval(
        `/^Turn Work off on this (Mac|PC|computer)\\?/i.test(document.querySelector(${JSON.stringify(confirm)})?.innerText ?? '')`
      ))
      assert.deepEqual(await read(), [true, true], 'Work changed before confirmation')
      await page.clickOn(confirm + ' button', 'Turn off')
      await expectRead(page, 'desktop work.get enabled', () => workOn(pair, win), false)
      assert.deepEqual(await read(), [false, true], 'turning Work off did not affect only the desktop')
    })
  ]
})
