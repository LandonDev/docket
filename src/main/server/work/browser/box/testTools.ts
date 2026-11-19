import { videoToolsAt, type VideoTools } from './videoSetting'

/**
 * The installed video tools a live test runs against, or null where there
 * are none (the test then skips): the userData `TEMP_CODE_TEST_VIDEO_TOOLS`
 * names, else this host's own. Install them into a scratch folder with
 * `bun scripts/work-tools/install.ts --data <dir> --only screen-relay`.
 */
export function testVideoTools(env: NodeJS.ProcessEnv = process.env): VideoTools | null {
  if (process.platform !== 'linux') return null
  for (const dataDir of [env.TEMP_CODE_TEST_VIDEO_TOOLS, env.TEMP_CODE_USER_DATA]) {
    const tools = dataDir ? videoToolsAt(dataDir) : null
    if (tools) return tools
  }
  return null
}
