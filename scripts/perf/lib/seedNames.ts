/** What scripts/perf/seed-box.ts puts in the isolated box of a code-family run, by name: the rows find them by these. */
export const SEED_THREADS = {
  long: { id: 'perf-long', title: 'Perf long, 30,000 rows', type: 'implementation', rows: 30_000, turns: 2, seed: 21 },
  chat: { id: 'perf-chat', title: 'Perf chat, 2,000 rows', type: 'chat', rows: 2_000, turns: 40, seed: 22 }
} as const
export const SEED_SHORT = Array.from({ length: 6 }, (_, i) => ({ id: `perf-short-${i + 1}`, title: `Perf short ${i + 1}`, type: 'chat' as const, rows: 300, turns: 3, seed: 30 + i }))
export const SEED_WORKSPACE = 'Perf code'
export const SEED_FILES = 20_000
