import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { barrelMap, directIconImports, rewriteIconImports } from './iconImports'

const BARREL = `import * as index from './icons/index.mjs';
export { index as icons };
export { default as IconX } from './icons/IconX.mjs';
export { default as AlarmCheck, default as AlarmCheckIcon, default as LucideAlarmCheck } from './icons/alarm-clock-check.js';
export { createIcon } from './createIcon.mjs';`

describe('icon imports straight to the icon', () => {
  const map = barrelMap(BARREL, '/pkg/dist/esm')
  const maps = new Map([['@tabler/icons-react', map]])

  it("reads every default re-export's names, and nothing else", () => {
    expect([...map.keys()]).toEqual(['IconX', 'AlarmCheck', 'AlarmCheckIcon', 'LucideAlarmCheck'])
    expect(map.get('AlarmCheckIcon')).toBe('/pkg/dist/esm/icons/alarm-clock-check.js')
  })

  it('makes each named import a default import of its file; renames, types and names it cannot map are kept right', () => {
    const code = `import { IconX, AlarmCheck as Alarm, type IconProps, createIcon } from "@tabler/icons-react"\nimport { useState } from 'react'`
    const out = rewriteIconImports(code, maps)!
    expect(out).toContain('import IconX from "/pkg/dist/esm/icons/IconX.mjs";')
    expect(out).toContain('import Alarm from "/pkg/dist/esm/icons/alarm-clock-check.js";')
    expect(out).toContain('import { createIcon } from "@tabler/icons-react";')
    expect(out).not.toContain('IconProps')
    expect(out).toContain("import { useState } from 'react'")
  })

  it('leaves a type-only import, another package and code with no barrel alone', () => {
    expect(rewriteIconImports('import type { IconProps } from "@tabler/icons-react"', maps)).toBeNull()
    expect(rewriteIconImports('import { IconX } from "other-icons"', maps)).toBeNull()
  })

  it("maps the installed packages' own barrels to files that exist", () => {
    const plugin = directIconImports(join(import.meta.dirname, '..', '..'))
    ;(plugin.buildStart as () => void).call({})
    const out = (plugin.transform as (code: string, id: string) => { code: string } | null).call({}, 'import { IconDots } from "@tabler/icons-react"; import { ChevronDown } from "lucide-react"', '/x/a.tsx')!
    const files = [...out.code.matchAll(/from "([^"]+)"/g)].map((m) => m[1]!)
    expect(files).toHaveLength(2)
    for (const f of files) expect(existsSync(f), f).toBe(true)
  })
})
