/**
 * Whether a save of ours in the VM is still owed to the cloud (files/uploads.ts `uploadsOwed`), told to the keeper
 * through this one seam: the Files pillar sets it when it loads. No import here, so the VM pillar never pulls the
 * Files graph in with it (a built app once ran a Files module before the one it reads: b0a5ac224).
 */
let owed: () => boolean = () => false

export function setUploadsOwed(fn: () => boolean): void {
  owed = fn
}

export const uploadsOwed = (): boolean => owed()
