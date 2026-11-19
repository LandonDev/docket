// electron-builder's Windows sign hook (electron-builder.yml `win.signtoolOptions.sign`), called
// once per executable of a Windows build. It is empty on purpose: the Windows build ships
// unsigned, and SmartScreen asks once ("More info", "Run anyway"). A certificate goes in here
// only if a machine refuses the unsigned build; LifeOS's apps/desktop/scripts/sign-win.mjs (jsign
// with Azure Artifact Signing, which runs on a Mac) is the pattern to copy then.

/** @param {{ path: string }} _configuration */
export default async function sign(_configuration) {}
