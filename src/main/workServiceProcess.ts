/**
 * Entry of the Work service's utility process (docs/agents/work.md): the
 * one process that serves live documents and sheets, guest links, the
 * hosted pages and the Office relay. It never opens the app's database and
 * never reads the vault; main feeds it over its wire.
 *
 * A stub. The build makes its bundle (`workService` in
 * electron.vite.config.ts) so that milestone 18 fills this file and edits
 * no build entry. Nothing forks it yet; a fork of the stub says so and
 * exits, never serving anything.
 */
console.error('not built: the Work service (milestone 18)')
process.exit(1)
