import { hostedBuildConfig } from '../electron.vite.config'

/**
 * The hosted pages' build as a config file of its own, for the process
 * `hostedPages` (electron.vite.config.ts) starts once the renderer's bundle is
 * written: the renderer build's heap is gone before this one begins. The out
 * folder comes in `TEMP_CODE_HOSTED_OUT`; left out, out/hosted.
 */
export default hostedBuildConfig(process.env.TEMP_CODE_HOSTED_OUT || undefined)
