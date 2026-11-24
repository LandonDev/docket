import { readMacOneDrive } from '../src/main/server/work/office/files/macOneDrive'

const mounts = readMacOneDrive()
if (!mounts.length) console.log('no OneDrive settings found')
for (const { path, web } of mounts) console.log(`${path}\t${web}`)
