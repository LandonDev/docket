//! The active display paths, viogpudo's private escape and Windows' DPI packets.

use std::mem::size_of;

use windows::core::{PCWSTR, PWSTR};
use windows::Wdk::Graphics::Direct3D::{
    D3DKMTCloseAdapter, D3DKMTEscape, D3DKMTOpenAdapterFromGdiDisplayName, D3DKMT_CLOSEADAPTER,
    D3DKMT_ESCAPE, D3DKMT_ESCAPE_DRIVERPRIVATE, D3DKMT_OPENADAPTERFROMGDIDISPLAYNAME,
};
use windows::Win32::Devices::DeviceAndDriverInstallation::{
    CM_Get_DevNode_PropertyW, CM_Get_Device_Interface_PropertyW, CM_Locate_DevNodeW,
    CM_LOCATE_DEVNODE_NORMAL, CR_SUCCESS, MAX_DEVICE_ID_LEN,
};
use windows::Win32::Devices::Display::*;
use windows::Win32::Devices::Properties::{
    DEVPKEY_Device_InstanceId, DEVPKEY_Device_Service, DEVPROP_TYPE_STRING,
};
use windows::Win32::Foundation::{ERROR_INSUFFICIENT_BUFFER, LUID};
use windows::Win32::Graphics::Gdi::{
    EnumDisplayDevicesW, DISPLAY_DEVICEW, DISPLAY_DEVICE_PRIMARY_DEVICE,
};

use crate::desktop::fail;
use crate::display::{DisplayAdapter, DpiSteps, Primary};
use crate::wire::{ComputerError, ComputerErrorKind, DisplayGetResult};

pub(super) struct WindowsDisplay;

pub(super) struct Source {
    adapter: LUID,
    id: u32,
    name: [u16; 32],
    paths: Vec<DISPLAYCONFIG_PATH_INFO>,
    modes: Vec<DISPLAYCONFIG_MODE_INFO>,
    mode_index: usize,
}

impl Source {
    fn header<T>(&self, kind: DISPLAYCONFIG_DEVICE_INFO_TYPE) -> DISPLAYCONFIG_DEVICE_INFO_HEADER {
        DISPLAYCONFIG_DEVICE_INFO_HEADER {
            r#type: kind,
            size: size_of::<T>() as u32,
            adapterId: self.adapter,
            id: self.id,
        }
    }
}

#[repr(C)]
struct ReadDpi {
    header: DISPLAYCONFIG_DEVICE_INFO_HEADER,
    min: i32,
    current: i32,
    max: i32,
}

#[repr(C)]
struct WriteDpi {
    header: DISPLAYCONFIG_DEVICE_INFO_HEADER,
    relative: i32,
}

// mm322, viogpu/shared/viogpum.h. The union's resolution member is two USHORTs.
#[repr(C, packed)]
struct VioGpuEscape {
    kind: u16,
    length: u16,
    width: u16,
    height: u16,
}

const _: () = {
    assert!(size_of::<VioGpuEscape>() == 8);
    assert!(size_of::<ReadDpi>() == 32);
    assert!(size_of::<WriteDpi>() == 24);
};

const GET_CUSTOM_RESOLUTION: u16 = 0x01;
const SET_CUSTOM_RESOLUTION: u16 = 0x02;

struct Adapter(u32);

impl Adapter {
    fn open(source: &Source) -> Result<Self, ComputerError> {
        let mut open = D3DKMT_OPENADAPTERFROMGDIDISPLAYNAME {
            DeviceName: source.name,
            ..Default::default()
        };
        let status = unsafe { D3DKMTOpenAdapterFromGdiDisplayName(&mut open) };
        if status.0 < 0 {
            return Err(display_error(format!(
                "open the primary display adapter: {:#010x}",
                status.0
            )));
        }
        let adapter = Self(open.hAdapter);
        if open.AdapterLuid != source.adapter || open.VidPnSourceId != source.id {
            return Err(display_error(
                "the primary display changed before it could be opened",
            ));
        }
        Ok(adapter)
    }

    fn custom_mode(&self, kind: u16, width: u16, height: u16) -> Option<(u16, u16)> {
        let mut data = VioGpuEscape {
            kind,
            length: 4,
            width,
            height,
        };
        let escape = D3DKMT_ESCAPE {
            hAdapter: self.0,
            Type: D3DKMT_ESCAPE_DRIVERPRIVATE,
            pPrivateDriverData: (&mut data as *mut VioGpuEscape).cast(),
            PrivateDriverDataSize: size_of::<VioGpuEscape>() as u32,
            ..Default::default()
        };
        let status = unsafe { D3DKMTEscape(&escape) };
        if status.0 < 0 {
            eprintln!(
                "display.set: viogpudo escape {kind} refused ({:#010x})",
                status.0
            );
            return None;
        }
        Some((data.width, data.height))
    }
}

impl Drop for Adapter {
    fn drop(&mut self) {
        let _ = unsafe { D3DKMTCloseAdapter(&D3DKMT_CLOSEADAPTER { hAdapter: self.0 }) };
    }
}

fn display_error(message: impl Into<String>) -> ComputerError {
    fail(ComputerErrorKind::ActionUnsupported, message)
}

fn check_status(api: &str, code: i32) -> Result<(), ComputerError> {
    if code == 0 {
        Ok(())
    } else {
        Err(display_error(format!("{api} failed ({code})")))
    }
}

fn wide_text(value: &[u16]) -> &[u16] {
    value.split(|&ch| ch == 0).next().unwrap_or_default()
}

fn primary_device() -> Result<DISPLAY_DEVICEW, ComputerError> {
    for index in 0.. {
        let mut device = DISPLAY_DEVICEW {
            cb: size_of::<DISPLAY_DEVICEW>() as u32,
            ..Default::default()
        };
        if !unsafe { EnumDisplayDevicesW(PCWSTR::null(), index, &mut device, 0) }.as_bool() {
            break;
        }
        if device.StateFlags.contains(DISPLAY_DEVICE_PRIMARY_DEVICE) {
            return Ok(device);
        }
    }
    Err(display_error("Windows has no primary display"))
}

fn active_config(
) -> Result<(Vec<DISPLAYCONFIG_PATH_INFO>, Vec<DISPLAYCONFIG_MODE_INFO>), ComputerError> {
    for _ in 0..3 {
        let (mut paths, mut modes) = (0, 0);
        let flags = QDC_ONLY_ACTIVE_PATHS;
        let status = unsafe { GetDisplayConfigBufferSizes(flags, &mut paths, &mut modes) };
        check_status("GetDisplayConfigBufferSizes", status.0 as i32)?;
        let mut path_info = vec![DISPLAYCONFIG_PATH_INFO::default(); paths as usize];
        let mut mode_info = vec![DISPLAYCONFIG_MODE_INFO::default(); modes as usize];
        let status = unsafe {
            QueryDisplayConfig(
                flags,
                &mut paths,
                path_info.as_mut_ptr(),
                &mut modes,
                mode_info.as_mut_ptr(),
                None,
            )
        };
        if status == ERROR_INSUFFICIENT_BUFFER {
            continue;
        }
        check_status("QueryDisplayConfig", status.0 as i32)?;
        path_info.truncate(paths as usize);
        mode_info.truncate(modes as usize);
        return Ok((path_info, mode_info));
    }
    Err(display_error("Windows' active display paths kept changing"))
}

fn source_name(source: &DISPLAYCONFIG_PATH_SOURCE_INFO) -> Option<[u16; 32]> {
    let mut name = DISPLAYCONFIG_SOURCE_DEVICE_NAME {
        header: DISPLAYCONFIG_DEVICE_INFO_HEADER {
            r#type: DISPLAYCONFIG_DEVICE_INFO_GET_SOURCE_NAME,
            size: size_of::<DISPLAYCONFIG_SOURCE_DEVICE_NAME>() as u32,
            adapterId: source.adapterId,
            id: source.id,
        },
        ..Default::default()
    };
    (unsafe { DisplayConfigGetDeviceInfo((&raw mut name).cast()) } == 0)
        .then_some(name.viewGdiDeviceName)
}

impl DisplayAdapter for WindowsDisplay {
    type Source = Source;

    fn primary(&self) -> Result<Primary<Source>, ComputerError> {
        let device = primary_device()?;
        let (paths, modes) = active_config()?;
        let path = paths
            .iter()
            .map(|p| p.sourceInfo)
            .find(|path| {
                source_name(path)
                    .is_some_and(|name| wide_text(&name) == wide_text(&device.DeviceName))
            })
            .ok_or_else(|| display_error("Windows has no active path for the primary display"))?;
        // QDC_ONLY_ACTIVE_PATHS without QDC_VIRTUAL_MODE_AWARE uses the full modeInfoIdx.
        let mode_index = unsafe { path.Anonymous.modeInfoIdx } as usize;
        let mode = modes
            .get(mode_index)
            .filter(|mode| {
                mode.infoType == DISPLAYCONFIG_MODE_INFO_TYPE_SOURCE
                    && mode.adapterId == path.adapterId
                    && mode.id == path.id
            })
            .ok_or_else(|| display_error("Windows has no source mode for the primary display"))?;
        let mode = unsafe { mode.Anonymous.sourceMode };
        let source = Source {
            adapter: path.adapterId,
            id: path.id,
            name: device.DeviceName,
            paths,
            modes,
            mode_index,
        };
        let mut dpi = ReadDpi {
            header: source.header::<ReadDpi>(DISPLAYCONFIG_DEVICE_INFO_TYPE(-3)),
            min: 0,
            current: 0,
            max: 0,
        };
        check_status("DisplayConfigGetDeviceInfo DPI", unsafe {
            DisplayConfigGetDeviceInfo((&raw mut dpi).cast())
        })?;
        let dpi = DpiSteps {
            min: dpi.min,
            current: dpi.current,
            max: dpi.max,
        };
        let scale = dpi
            .percent()
            .ok_or_else(|| display_error("Windows returned an unknown DPI step"))?;
        let mode = DisplayGetResult {
            width: i64::from(mode.width),
            height: i64::from(mode.height),
            scale,
            adapter: String::from_utf16_lossy(wide_text(&device.DeviceString)),
        };
        Ok(Primary { source, mode, dpi })
    }

    fn is_viogpudo(&self, source: &Source) -> bool {
        // The device can have VirtIO PCI IDs even when Microsoft's fallback driver is in use.
        let mut name = DISPLAYCONFIG_ADAPTER_NAME {
            header: DISPLAYCONFIG_DEVICE_INFO_HEADER {
                id: 0,
                ..source.header::<DISPLAYCONFIG_ADAPTER_NAME>(
                    DISPLAYCONFIG_DEVICE_INFO_GET_ADAPTER_NAME,
                )
            },
            ..Default::default()
        };
        if unsafe { DisplayConfigGetDeviceInfo((&raw mut name).cast()) } != 0 {
            return false;
        }
        let mut instance = [0u16; MAX_DEVICE_ID_LEN as usize];
        let mut kind = Default::default();
        let mut bytes = std::mem::size_of_val(&instance) as u32;
        let status = unsafe {
            CM_Get_Device_Interface_PropertyW(
                PCWSTR(name.adapterDevicePath.as_ptr()),
                &DEVPKEY_Device_InstanceId,
                &mut kind,
                Some(instance.as_mut_ptr().cast()),
                &mut bytes,
                0,
            )
        };
        if status != CR_SUCCESS || kind != DEVPROP_TYPE_STRING {
            return false;
        }
        let mut devnode = 0;
        if unsafe {
            CM_Locate_DevNodeW(
                &mut devnode,
                PWSTR(instance.as_mut_ptr()),
                CM_LOCATE_DEVNODE_NORMAL,
            )
        } != CR_SUCCESS
        {
            return false;
        }
        let mut service = [0u16; 256];
        let mut bytes = std::mem::size_of_val(&service) as u32;
        let status = unsafe {
            CM_Get_DevNode_PropertyW(
                devnode,
                &DEVPKEY_Device_Service,
                &mut kind,
                Some(service.as_mut_ptr().cast()),
                &mut bytes,
                0,
            )
        };
        status == CR_SUCCESS
            && kind == DEVPROP_TYPE_STRING
            && String::from_utf16_lossy(wide_text(&service)).eq_ignore_ascii_case("viogpudo")
    }

    fn resize(&self, source: &mut Source, width: u16, height: u16) -> Result<bool, ComputerError> {
        let adapter = Adapter::open(source)?;
        if adapter
            .custom_mode(SET_CUSTOM_RESOLUTION, width, height)
            .is_none()
            || adapter.custom_mode(GET_CUSTOM_RESOLUTION, 0, 0) != Some((width, height))
        {
            return Ok(false);
        }
        let mode = unsafe { &mut source.modes[source.mode_index].Anonymous.sourceMode };
        mode.width = u32::from(width);
        mode.height = u32::from(height);
        let flags =
            SDC_APPLY | SDC_USE_SUPPLIED_DISPLAY_CONFIG | SDC_ALLOW_CHANGES | SDC_SAVE_TO_DATABASE;
        let code = unsafe { SetDisplayConfig(Some(&source.paths), Some(&source.modes), flags) };
        if code != 0 {
            eprintln!("display.set: SetDisplayConfig refused ({code})");
        }
        Ok(code == 0)
    }

    fn set_scale(&self, source: &Source, relative: i32) {
        let dpi = WriteDpi {
            header: source.header::<WriteDpi>(DISPLAYCONFIG_DEVICE_INFO_TYPE(-4)),
            relative,
        };
        let code = unsafe { DisplayConfigSetDeviceInfo((&raw const dpi).cast()) };
        if code != 0 {
            eprintln!("display.set: Windows refused the requested DPI step ({code})");
        }
    }
}
