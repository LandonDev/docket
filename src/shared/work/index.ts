/**
 * Work's shared types, one import for both sides (docs/agents/work.md).
 * The server's own (`WorkModule`, `WorkCtx`, `ToolCtx`, `ActCtx`, `Caller`)
 * are in src/main/server/work/modules.ts, since they hold the database.
 */
export * from './ids'
export * from './canvas'
export * from './mentions'
export * from './acts'
export * from './triggers'
export * from './scope'
export * from './tools'
export * from './wire'
export * from './because'
export * from './health'
