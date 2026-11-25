import type { RigConfig, RigPaths } from './config'

export interface Machine {
  disk: string
  vars: string
  install?: InstallMedia
  /** QEMU's own window on an X display (the standing machine's picture); none by default */
  window?: VmWindow
  /** the display device the guest runs on; std VGA by default */
  device?: DisplayDevice
  /** Guest-to-box forwards for one run (`up.sh --guestfwd`): a connection to `guest` reaches 127.0.0.1:`port` on the box. */
  guestfwd?: GuestFwd[]
}

export interface GuestFwd {
  /** an address in the user network's 10.0.2.0/24 and a port, e.g. 10.0.2.100:445 */
  guest: string
  /** the box's own port it reaches, on 127.0.0.1 only */
  port: number
}

/** `10.0.2.100:445=44500`, refused unless the guest side is in 10.0.2.0/24 and not the gateway, DNS or the guest itself. */
export function parseGuestFwd(text: string): GuestFwd {
  const m = /^(10\.0\.2\.(\d{1,3})):(\d{1,5})=(\d{1,5})$/.exec(text.trim())
  const host = Number(m?.[2])
  const ports = [Number(m?.[3]), Number(m?.[4])]
  if (!m || host < 4 || host > 254 || host === 15 || ports.some((n) => n < 1 || n > 65535)) throw new Error(`--guestfwd ${text}: give 10.0.2.N:PORT=BOXPORT (N 4 to 254, not 15)`)
  return { guest: `${m[1]}:${ports[0]}`, port: ports[1]! }
}

/** One guestfwd: each connection starts its own `nc` to the box's loopback, so the forward takes any number of them. */
const guestFwdArg = (f: GuestFwd): string => `guestfwd=tcp:${f.guest}-cmd:/usr/bin/nc 127.0.0.1 ${f.port}`

/** The guest's screen in QEMU's GTK window: the display QEMU draws on comes in its environment (DISPLAY). */
export interface VmWindow {
  width: number
  height: number
}

/** The std VGA's EDID offers 1280×800 when it is given no size, which is the screen the image was made at. */
export const VGA_DEFAULT = { width: 1280, height: 800 } as const

/**
 * The window: GTK with nothing of its own around the guest's screen (no menu bar, no tabs, drawn 1:1), and a close
 * of the window never stops the machine. Another size is the same VGA device told its EDID's mode, so a hibernated
 * guest wakes on the hardware it slept on.
 */
export function windowArgs(w: VmWindow): string[] {
  const size = w.width === VGA_DEFAULT.width && w.height === VGA_DEFAULT.height ? [] : ['-global', `VGA.xres=${w.width}`, '-global', `VGA.yres=${w.height}`]
  return ['-display', GTK, ...size]
}
const GTK = 'gtk,show-menubar=off,show-tabs=off,zoom-to-fit=off,window-close=off'

/**
 * The guest's display device. `vga` is QEMU's std VGA under Windows' Basic Display Driver: one size, the
 * firmware's, kept until a cold boot. `virtio` is virtio-vga under Red Hat's viogpudo: any size, set from inside
 * the guest while it runs (docs/agents/work-winvm.md "The picture").
 */
export type DisplayDevice = 'vga' | 'virtio'

/** std VGA's 16 MB of video memory holds 2560×1600 at four bytes a pixel and nothing larger. */
const VGA_MEMORY_PIXELS = 2560 * 1600

/**
 * The device and its display. On virtio the size is the EDID's preferred mode, which viogpudo takes at a cold
 * boot; OVMF draws on either with a driver of its own, so no option ROM is measured into the TPM.
 */
export function displayArgs(device: DisplayDevice, window?: VmWindow): string[] {
  if (device === 'virtio') {
    const size = window ? `,xres=${window.width},yres=${window.height}` : ''
    return ['-vga', 'none', '-device', `virtio-vga,edid=on${size}`, '-display', window ? GTK : 'none']
  }
  if (!window) return ['-vga', 'std', '-display', 'none']
  const memory = window.width * window.height > VGA_MEMORY_PIXELS ? ['-global', 'VGA.vgamem_mb=64'] : []
  return ['-vga', 'std', ...windowArgs(window), ...memory]
}

export interface InstallMedia {
  iso: string
  /** A folder QEMU presents as a read-only FAT USB stick: Windows Setup finds autounattend.xml at its root. */
  configDir: string
}

/**
 * The machine: KVM with the Hyper-V enlightenments Windows expects, Secure Boot firmware, a software TPM 2.0,
 * an AHCI disk and an e1000e NIC (both have drivers in Windows, so no driver ISO), a USB tablet for absolute
 * pointer input, user-mode networking with forwards bound to 127.0.0.1 only, no display (QMP takes screenshots) unless
 * it is given a window.
 */
export function qemuArgs(c: RigConfig, p: RigPaths, { disk, vars, install, window, device = 'vga', guestfwd = [] }: Machine): string[] {
  const fwd = [`hostfwd=tcp:127.0.0.1:${c.sshPort}-:22`, ...(c.cdpPort === null ? [] : [`hostfwd=tcp:127.0.0.1:${c.cdpPort}-:${c.cdpPort}`]), ...guestfwd.map(guestFwdArg)]
  const args = [
    '-name', `${c.process},process=${c.process}`,
    '-machine', 'q35,smm=on,accel=kvm',
    '-cpu', 'host,hv_relaxed,hv_vapic,hv_spinlocks=0x1fff,hv_time,hv_vpindex,hv_synic,hv_stimer',
    '-smp', `${c.cpus},sockets=1,cores=${c.cpus},threads=1`,
    '-m', c.memory,
    '-rtc', 'base=utc',
    '-global', 'driver=cfi.pflash01,property=secure,value=on',
    '-drive', `if=pflash,format=raw,unit=0,readonly=on,file=${c.ovmfCode}`,
    '-drive', `if=pflash,format=raw,unit=1,file=${vars}`,
    '-chardev', `socket,id=chrtpm,path=${p.tpmSock}`,
    '-tpmdev', 'emulator,id=tpm0,chardev=chrtpm',
    '-device', 'tpm-crb,tpmdev=tpm0',
    '-drive', `file=${disk},if=none,id=disk0,format=qcow2,discard=unmap${c.diskCache ? `,cache=${c.diskCache}` : ''}`,
    '-device', 'ide-hd,drive=disk0,bus=ide.0,bootindex=0',
    '-netdev', `user,id=n0,${fwd.join(',')}`,
    '-device', 'e1000e,netdev=n0',
    '-device', 'qemu-xhci,id=xhci',
    '-device', 'usb-tablet,bus=xhci.0',
    ...displayArgs(device, window),
    '-monitor', 'none',
    '-qmp', `unix:${p.qmp},server=on,wait=off`,
    '-pidfile', p.pid,
    '-daemonize'
  ]
  if (install) {
    args.push(
      '-drive', `file=${install.iso},if=none,id=cd0,media=cdrom,readonly=on`,
      '-device', 'ide-cd,drive=cd0,bus=ide.1,bootindex=1',
      '-drive', `file=fat:${install.configDir},if=none,id=cfg,format=raw,readonly=on`,
      '-device', 'usb-storage,bus=xhci.0,drive=cfg,removable=on'
    )
  }
  return args
}

/** swtpm as a daemon that exits when QEMU lets go of it; live state, socket, pid and log under /tmp (its AppArmor profile). */
export function swtpmArgs(p: RigPaths): string[] {
  return [
    'socket', '--tpm2',
    '--tpmstate', `dir=${p.tpmState}`,
    '--ctrl', `type=unixio,path=${p.tpmSock}`,
    '--pid', `file=${p.tpmPid}`,
    '--log', `file=${p.tpmLog},level=1`,
    '--terminate', '--daemon'
  ]
}
