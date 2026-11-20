//! Live video on Windows (docs/computer-protocol.md §30): the bytes pipe the
//! host names in the environment, dialed with overlapped I/O so a read and a
//! write can wait at once; the window's capture through
//! Windows.Graphics.Capture on a D3D11 device (the hardware one, else WARP),
//! or PrintWindow on a timer where that capture is refused; and the Media
//! Foundation H.264 encoder, a hardware one when the machine offers one, else
//! Microsoft's software encoder. `crate::video` drives them.

use std::ffi::c_void;
use std::io::{Read, Write};
use std::mem::ManuallyDrop;
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant};

use windows::core::{Interface, HSTRING};
use windows::Foundation::TypedEventHandler;
use windows::Graphics::Capture::{Direct3D11CaptureFramePool, GraphicsCaptureItem, GraphicsCaptureSession};
use windows::Graphics::DirectX::Direct3D11::IDirect3DDevice;
use windows::Graphics::DirectX::DirectXPixelFormat;
use windows::Graphics::SizeInt32;
use windows::Win32::Foundation::*;
use windows::Win32::Graphics::Direct3D::{D3D_DRIVER_TYPE, D3D_DRIVER_TYPE_HARDWARE, D3D_DRIVER_TYPE_WARP};
use windows::Win32::Graphics::Direct3D11::*;
use windows::Win32::Graphics::Dxgi::Common::DXGI_FORMAT_B8G8R8A8_UNORM;
use windows::Win32::Graphics::Dxgi::IDXGIDevice;
use windows::Win32::Media::MediaFoundation::*;
use windows::Win32::Storage::FileSystem::{CreateFileW, ReadFile, WriteFile, FILE_FLAG_OVERLAPPED, FILE_SHARE_NONE, OPEN_EXISTING, PIPE_ACCESS_DUPLEX};
use windows::Win32::System::Com::{CoCreateInstance, CoTaskMemFree, CLSCTX_INPROC_SERVER};
use windows::Win32::System::Pipes::{ConnectNamedPipe, CreateNamedPipeW, WaitNamedPipeW, PIPE_READMODE_BYTE, PIPE_TYPE_BYTE, PIPE_WAIT};
use windows::Win32::System::Threading::CreateEventW;
use windows::Win32::System::Variant::{VARIANT, VARIANT_0, VARIANT_0_0, VARIANT_0_0_0, VT_BOOL, VT_UI4};
use windows::Win32::System::WinRT::Direct3D11::{CreateDirect3D11DeviceFromDXGIDevice, IDirect3DDxgiInterfaceAccess};
use windows::Win32::System::WinRT::Graphics::Capture::IGraphicsCaptureItemInterop;
use windows::Win32::System::WinRT::{RoInitialize, RO_INIT_MULTITHREADED};
use windows::Win32::System::IO::{GetOverlappedResult, OVERLAPPED};
use windows::Win32::UI::WindowsAndMessaging::IsWindow;

use super::windows::com;
use crate::capture::fingerprint;
use crate::desktop::fail;
use crate::video::annexb::Normalizer;
use crate::video::picture::Picture;
use crate::video::{mono_us, CaptureEnd, Encoded, EncoderSpec, VideoEncoder, WindowCapture};
use crate::wire::{ComputerError, ComputerErrorKind, VideoMode};

// ── the bytes pipe ──────────────────────────────────────────────────────

struct PipeHandle(HANDLE);
unsafe impl Send for PipeHandle {}
unsafe impl Sync for PipeHandle {}
impl Drop for PipeHandle {
    fn drop(&mut self) {
        let _ = unsafe { CloseHandle(self.0) };
    }
}

/// One direction of an overlapped pipe handle, with its own event: a read waits while a write goes on.
struct PipeEnd {
    h: Arc<PipeHandle>,
    ev: PipeHandle,
}

impl PipeEnd {
    fn new(h: Arc<PipeHandle>) -> std::io::Result<Self> {
        let ev = unsafe { CreateEventW(None, true, false, None) }.map_err(io_err)?;
        Ok(PipeEnd { h, ev: PipeHandle(ev) })
    }

    /// One overlapped read or write, waited for; a closed other end reads as 0 bytes.
    fn run(&mut self, op: impl FnOnce(HANDLE, *mut OVERLAPPED) -> windows::core::Result<()>) -> std::io::Result<usize> {
        let mut ov = OVERLAPPED { hEvent: self.ev.0, ..Default::default() };
        if let Err(e) = op(self.h.0, &mut ov) {
            if e.code() != ERROR_IO_PENDING.to_hresult() {
                return closed_or(e);
            }
        }
        let mut n = 0u32;
        match unsafe { GetOverlappedResult(self.h.0, &ov, &mut n, true) } {
            Ok(()) => Ok(n as usize),
            Err(e) => closed_or(e),
        }
    }
}

fn closed_or(e: windows::core::Error) -> std::io::Result<usize> {
    if [ERROR_BROKEN_PIPE, ERROR_PIPE_NOT_CONNECTED, ERROR_NO_DATA].iter().any(|c| e.code() == c.to_hresult()) {
        Ok(0)
    } else {
        Err(io_err(e))
    }
}

fn io_err(e: windows::core::Error) -> std::io::Error {
    std::io::Error::other(e.message())
}

impl Read for PipeEnd {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        let len = buf.len().min(u32::MAX as usize);
        let ptr = buf.as_mut_ptr();
        self.run(|h, ov| unsafe { ReadFile(h, Some(std::slice::from_raw_parts_mut(ptr, len)), None, Some(ov)) })
    }
}

impl Write for PipeEnd {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        let n = self.run(|h, ov| unsafe { WriteFile(h, Some(buf), None, Some(ov)) })?;
        if n == 0 && !buf.is_empty() {
            return Err(std::io::Error::new(std::io::ErrorKind::BrokenPipe, "the other end closed the pipe"));
        }
        Ok(n)
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

type Ends = (Box<dyn Read + Send>, Box<dyn Write + Send>);

fn ends(h: HANDLE) -> std::io::Result<Ends> {
    let h = Arc::new(PipeHandle(h));
    Ok((Box::new(PipeEnd::new(h.clone())?), Box::new(PipeEnd::new(h)?)))
}

/// Dials the host's named pipe, waiting up to 2 s for it to take a client.
pub fn dial(name: &str) -> std::io::Result<Ends> {
    let wide = HSTRING::from(name);
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        let r = unsafe { CreateFileW(&wide, GENERIC_READ.0 | GENERIC_WRITE.0, FILE_SHARE_NONE, None, OPEN_EXISTING, FILE_FLAG_OVERLAPPED, None) };
        match r {
            Ok(h) => return ends(h),
            Err(e) if Instant::now() < deadline && [ERROR_PIPE_BUSY, ERROR_FILE_NOT_FOUND].iter().any(|c| e.code() == c.to_hresult()) => {
                let _ = unsafe { WaitNamedPipeW(&wide, 200) };
                std::thread::sleep(Duration::from_millis(20));
            }
            Err(e) => return Err(io_err(e)),
        }
    }
}

/// The rig's proof only (`tc-computer pipe-relay`): makes the named pipe the service dials, takes one loopback TCP
/// connection, and carries bytes both ways between them until either closes. The host is on another machine there.
pub fn relay(name: &str, listener: std::net::TcpListener) -> std::io::Result<()> {
    let wide = HSTRING::from(name);
    let h = unsafe { CreateNamedPipeW(&wide, PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED, PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT, 1, 1 << 20, 1 << 20, 0, None) };
    if h.is_invalid() {
        return Err(std::io::Error::last_os_error());
    }
    let pipe = Arc::new(PipeHandle(h));
    {
        let mut end = PipeEnd::new(pipe.clone())?;
        let connected = end.run(|h, ov| unsafe { ConnectNamedPipe(h, Some(ov)) });
        // a client that came between the pipe's making and the call is already connected
        if let Err(e) = connected {
            if e.raw_os_error() != Some(ERROR_PIPE_CONNECTED.0 as i32) {
                return Err(e);
            }
        }
    }
    eprintln!("relay: the service is on {name}");
    let (tcp, _) = listener.accept()?;
    eprintln!("relay: the host is on {}", tcp.local_addr()?);
    let (mut pipe_in, mut pipe_out) = (PipeEnd::new(pipe.clone())?, PipeEnd::new(pipe)?);
    let (mut tcp_in, mut tcp_out) = (tcp.try_clone()?, tcp);
    let up = std::thread::spawn(move || std::io::copy(&mut pipe_in, &mut tcp_out));
    let _ = std::io::copy(&mut tcp_in, &mut pipe_out);
    let _ = up.join();
    Ok(())
}

// ── capture ─────────────────────────────────────────────────────────────

fn failed(what: &str, e: windows::core::Error) -> ComputerError {
    fail(ComputerErrorKind::CaptureFailed, format!("{what}: {}", e.message()))
}

/// The window's capture: Windows.Graphics.Capture, else PrintWindow on a timer (with the reason in its kind).
pub fn capture(window: i64, fps: usize) -> Result<Box<dyn WindowCapture>, ComputerError> {
    com();
    let _ = unsafe { RoInitialize(RO_INIT_MULTITHREADED) };
    match Wgc::start(window) {
        Ok(c) => Ok(Box::new(c)),
        Err(e) => {
            eprintln!("video: Windows.Graphics.Capture refused window {window} ({}); PrintWindow on a timer instead", e.message);
            Ok(Box::new(Printed::new(window, fps, &e.message)))
        }
    }
}

/// A D3D11 device with BGRA: the machine's hardware, else WARP. Its adapter's name.
fn device() -> windows::core::Result<(ID3D11Device, ID3D11DeviceContext, String)> {
    let mut last = None;
    for driver in [D3D_DRIVER_TYPE_HARDWARE, D3D_DRIVER_TYPE_WARP] {
        match make_device(driver) {
            Ok((d, c)) => {
                let name = adapter_name(&d).unwrap_or_else(|| if driver == D3D_DRIVER_TYPE_WARP { "WARP".into() } else { "hardware".into() });
                return Ok((d, c, name));
            }
            Err(e) => last = Some(e),
        }
    }
    Err(last.unwrap())
}

fn make_device(driver: D3D_DRIVER_TYPE) -> windows::core::Result<(ID3D11Device, ID3D11DeviceContext)> {
    let (mut d, mut c) = (None, None);
    unsafe { D3D11CreateDevice(None, driver, HMODULE::default(), D3D11_CREATE_DEVICE_BGRA_SUPPORT, None, D3D11_SDK_VERSION, Some(&mut d), None, Some(&mut c))? };
    Ok((d.ok_or_else(|| windows::core::Error::from(E_FAIL))?, c.ok_or_else(|| windows::core::Error::from(E_FAIL))?))
}

fn adapter_name(d: &ID3D11Device) -> Option<String> {
    let dxgi: IDXGIDevice = d.cast().ok()?;
    let desc = unsafe { dxgi.GetAdapter().ok()?.GetDesc().ok()? };
    let n = desc.Description.iter().position(|c| *c == 0).unwrap_or(desc.Description.len());
    Some(String::from_utf16_lossy(&desc.Description[..n]))
}

/// Windows.Graphics.Capture of one window: a free-threaded frame pool of two, no cursor, no border where Windows
/// allows it. A frame arriving wakes `next`, which takes the newest and copies it to the CPU.
struct Wgc {
    hwnd: HWND,
    ctx: ID3D11DeviceContext,
    device: ID3D11Device,
    d3d: IDirect3DDevice,
    item: GraphicsCaptureItem,
    pool: Direct3D11CaptureFramePool,
    session: GraphicsCaptureSession,
    size: SizeInt32,
    staging: Option<(ID3D11Texture2D, u32, u32)>,
    arrived: Arc<(Mutex<bool>, Condvar)>,
    kind: String,
    /// frames read, and frames a newer one replaced in the pool before they were read
    read: u64,
    skipped: u64,
}

unsafe impl Send for Wgc {}

impl Wgc {
    fn start(window: i64) -> Result<Wgc, ComputerError> {
        if !GraphicsCaptureSession::IsSupported().unwrap_or(false) {
            return Err(fail(ComputerErrorKind::CaptureFailed, "Windows.Graphics.Capture is not supported here"));
        }
        let hwnd = HWND(window as *mut c_void);
        let (device, ctx, adapter) = device().map_err(|e| failed("no D3D11 device", e))?;
        let dxgi: IDXGIDevice = device.cast().map_err(|e| failed("no DXGI device", e))?;
        let d3d: IDirect3DDevice = unsafe { CreateDirect3D11DeviceFromDXGIDevice(&dxgi) }.and_then(|i| i.cast()).map_err(|e| failed("no WinRT device", e))?;
        let interop = windows::core::factory::<GraphicsCaptureItem, IGraphicsCaptureItemInterop>().map_err(|e| failed("no capture interop", e))?;
        let item: GraphicsCaptureItem = unsafe { interop.CreateForWindow(hwnd) }.map_err(|e| failed("the window cannot be captured", e))?;
        let size = item.Size().map_err(|e| failed("the window's size", e))?;
        let pool = Direct3D11CaptureFramePool::CreateFreeThreaded(&d3d, DirectXPixelFormat::B8G8R8A8UIntNormalized, 2, size).map_err(|e| failed("no frame pool", e))?;
        let session = pool.CreateCaptureSession(&item).map_err(|e| failed("no capture session", e))?;
        let _ = session.SetIsCursorCaptureEnabled(false);
        let borderless = session.SetIsBorderRequired(false).is_ok();
        let arrived: Arc<(Mutex<bool>, Condvar)> = Arc::default();
        {
            let arrived = arrived.clone();
            pool.FrameArrived(&TypedEventHandler::new(move |_, _| {
                *arrived.0.lock().unwrap_or_else(|e| e.into_inner()) = true;
                arrived.1.notify_one();
                Ok(())
            }))
            .map_err(|e| failed("no frame events", e))?;
        }
        session.StartCapture().map_err(|e| failed("the capture did not start", e))?;
        let kind = format!("wgc on {adapter}{}", if borderless { "" } else { ", with the border" });
        Ok(Wgc { hwnd, ctx, device, d3d, item, pool, session, size, staging: None, arrived, kind, read: 0, skipped: 0 })
    }

    fn copy(&mut self, frame: &windows::Graphics::Capture::Direct3D11CaptureFrame) -> windows::core::Result<Option<Picture>> {
        let content = frame.ContentSize()?;
        let access: IDirect3DDxgiInterfaceAccess = frame.Surface()?.cast()?;
        let tex: ID3D11Texture2D = unsafe { access.GetInterface()? };
        let mut desc = D3D11_TEXTURE2D_DESC::default();
        unsafe { tex.GetDesc(&mut desc) };
        let (w, h) = ((content.Width.max(0) as u32).min(desc.Width), (content.Height.max(0) as u32).min(desc.Height));
        if content.Width != self.size.Width || content.Height != self.size.Height {
            // the window changed size: the pool's buffers follow it from the next frame
            self.size = content;
            self.pool.Recreate(&self.d3d, DirectXPixelFormat::B8G8R8A8UIntNormalized, 2, content)?;
        }
        if w < 2 || h < 2 {
            return Ok(None);
        }
        if !self.staging.as_ref().is_some_and(|s| s.1 == w && s.2 == h) {
            let sd = D3D11_TEXTURE2D_DESC {
                Width: w,
                Height: h,
                MipLevels: 1,
                ArraySize: 1,
                Format: DXGI_FORMAT_B8G8R8A8_UNORM,
                SampleDesc: windows::Win32::Graphics::Dxgi::Common::DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
                Usage: D3D11_USAGE_STAGING,
                BindFlags: 0,
                CPUAccessFlags: D3D11_CPU_ACCESS_READ.0 as u32,
                MiscFlags: 0,
            };
            let mut t = None;
            unsafe { self.device.CreateTexture2D(&sd, None, Some(&mut t))? };
            self.staging = t.map(|t| (t, w, h));
        }
        let Some((staging, _, _)) = &self.staging else { return Ok(None) };
        let region = D3D11_BOX { left: 0, top: 0, front: 0, right: w, bottom: h, back: 1 };
        let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
        let mut bgra = vec![0u8; (w * h * 4) as usize];
        unsafe {
            self.ctx.CopySubresourceRegion(staging, 0, 0, 0, 0, &tex, 0, Some(&region));
            self.ctx.Map(staging, 0, D3D11_MAP_READ, 0, Some(&mut mapped))?;
            let row = (w * 4) as usize;
            for y in 0..h as usize {
                let src = std::slice::from_raw_parts((mapped.pData as *const u8).add(y * mapped.RowPitch as usize), row);
                bgra[y * row..(y + 1) * row].copy_from_slice(src);
            }
            self.ctx.Unmap(staging, 0);
        }
        Ok(Some(Picture { width: w as usize, height: h as usize, stride: (w * 4) as usize, bgra: Arc::new(bgra), at_us: mono_us() }))
    }
}

impl WindowCapture for Wgc {
    fn pixels(&self) -> (usize, usize) {
        let s = self.item.Size().unwrap_or(self.size);
        (s.Width.max(1) as usize, s.Height.max(1) as usize)
    }

    fn next(&mut self, wait: Duration) -> Result<Option<Picture>, CaptureEnd> {
        if !unsafe { IsWindow(Some(self.hwnd)) }.as_bool() {
            return Err(CaptureEnd::WindowClosed);
        }
        {
            let mut arrived = self.arrived.0.lock().unwrap_or_else(|e| e.into_inner());
            if !*arrived {
                arrived = self.arrived.1.wait_timeout(arrived, wait).map(|(a, _)| a).unwrap_or_else(|e| e.into_inner().0);
            }
            *arrived = false;
        }
        // the newest frame waiting; older ones go back to the pool
        let mut newest = None;
        while let Ok(f) = self.pool.TryGetNextFrame() {
            if let Some(old) = newest.replace(f) {
                self.skipped += 1;
                let _ = old.Close();
            }
        }
        let Some(frame) = newest else { return Ok(None) };
        self.read += 1;
        let picture = self.copy(&frame).map_err(|e| CaptureEnd::Error(format!("a frame could not be read: {}", e.message())));
        let _ = frame.Close();
        picture
    }

    fn kind(&self) -> String {
        self.kind.clone()
    }
}

impl Drop for Wgc {
    fn drop(&mut self) {
        eprintln!("video: the capture of window {:?} read {} frames, {} replaced in the pool before they were read", self.hwnd.0, self.read, self.skipped);
        let _ = self.session.Close();
        let _ = self.pool.Close();
    }
}

/// PrintWindow at the stream's fps, where Windows.Graphics.Capture is refused: a picture only when its pixels changed.
struct Printed {
    id: i64,
    interval: Duration,
    next_at: Instant,
    last: Option<u64>,
    kind: String,
}

impl Printed {
    fn new(id: i64, fps: usize, why: &str) -> Self {
        Printed { id, interval: Duration::from_micros(1_000_000 / fps.max(1) as u64), next_at: Instant::now(), last: None, kind: format!("printwindow ({why})") }
    }
}

impl WindowCapture for Printed {
    fn pixels(&self) -> (usize, usize) {
        let f = super::windows::window_frame(HWND(self.id as *mut c_void));
        (f.w.max(1.0) as usize, f.h.max(1.0) as usize)
    }

    fn next(&mut self, wait: Duration) -> Result<Option<Picture>, CaptureEnd> {
        if !super::io::alive(self.id) {
            return Err(CaptureEnd::WindowClosed);
        }
        let now = Instant::now();
        if now < self.next_at {
            std::thread::sleep((self.next_at - now).min(wait));
            if Instant::now() < self.next_at {
                return Ok(None);
            }
        }
        self.next_at = (self.next_at + self.interval).max(Instant::now());
        let f = super::windows::window_frame(HWND(self.id as *mut c_void));
        // minimized or mid-resize: nothing this time
        let Ok(img) = super::io::grab(self.id, (f.x as i32, f.y as i32, f.w as i32, f.h as i32)) else { return Ok(None) };
        let print = fingerprint(&img);
        if self.last == Some(print) {
            return Ok(None);
        }
        self.last = Some(print);
        let mut bgra = Vec::with_capacity(img.width * img.height * 4);
        for p in img.bgr.chunks_exact(3) {
            bgra.extend_from_slice(&[p[0], p[1], p[2], 255]);
        }
        Ok(Some(Picture { width: img.width, height: img.height, stride: img.width * 4, bgra: Arc::new(bgra), at_us: mono_us() }))
    }

    fn kind(&self) -> String {
        self.kind.clone()
    }
}

// ── the encoder ─────────────────────────────────────────────────────────

fn mf_started() -> Result<(), ComputerError> {
    static STARTED: OnceLock<Result<(), String>> = OnceLock::new();
    STARTED.get_or_init(|| unsafe { MFStartup(MF_VERSION, MFSTARTUP_LITE) }.map_err(|e| e.message())).clone().map_err(|m| fail(ComputerErrorKind::CaptureFailed, format!("Media Foundation did not start: {m}")))
}

fn var_u32(v: u32) -> VARIANT {
    VARIANT { Anonymous: VARIANT_0 { Anonymous: ManuallyDrop::new(VARIANT_0_0 { vt: VT_UI4, wReserved1: 0, wReserved2: 0, wReserved3: 0, Anonymous: VARIANT_0_0_0 { ulVal: v } }) } }
}

fn var_bool(v: bool) -> VARIANT {
    VARIANT { Anonymous: VARIANT_0 { Anonymous: ManuallyDrop::new(VARIANT_0_0 { vt: VT_BOOL, wReserved1: 0, wReserved2: 0, wReserved3: 0, Anonymous: VARIANT_0_0_0 { boolVal: VARIANT_BOOL(if v { -1 } else { 0 }) } }) } }
}

/// The Media Foundation H.264 encoder of one stream: low latency, no B-frames, a GOP as long as it takes, the
/// bitrate set through ICodecAPI (live in `budget`), a keyframe forced on ask, NV12 in, Annex B out.
pub struct MfEncoder {
    mft: IMFTransform,
    codec: Option<ICodecAPI>,
    /// an asynchronous (hardware) encoder's events, and the inputs it has asked for and not had
    events: Option<IMFMediaEventGenerator>,
    wants: usize,
    size: (usize, usize),
    fps: usize,
    normalizer: Normalizer,
    kind: String,
}

impl MfEncoder {
    pub fn new(spec: &EncoderSpec) -> Result<MfEncoder, ComputerError> {
        com();
        mf_started()?;
        match Self::hardware(spec) {
            Ok(Some(e)) => return Ok(e),
            Ok(None) => {}
            Err(why) => eprintln!("video: the hardware encoder failed ({why}); the software encoder instead"),
        }
        let mft: IMFTransform = unsafe { CoCreateInstance(&CLSID_MSH264EncoderMFT, None, CLSCTX_INPROC_SERVER) }.map_err(|e| failed("no H.264 encoder", e))?;
        Self::configure(mft, None, spec, "software (Microsoft H264 Encoder MFT)".into()).map_err(|e| failed("the H.264 encoder refused its settings", e))
    }

    /// The first hardware H.264 encoder that takes NV12 and these settings, unlocked for its events.
    fn hardware(spec: &EncoderSpec) -> Result<Option<MfEncoder>, String> {
        let input = MFT_REGISTER_TYPE_INFO { guidMajorType: MFMediaType_Video, guidSubtype: MFVideoFormat_NV12 };
        let output = MFT_REGISTER_TYPE_INFO { guidMajorType: MFMediaType_Video, guidSubtype: MFVideoFormat_H264 };
        let mut list: *mut Option<IMFActivate> = std::ptr::null_mut();
        let mut count = 0u32;
        unsafe { MFTEnumEx(MFT_CATEGORY_VIDEO_ENCODER, MFT_ENUM_FLAG_HARDWARE | MFT_ENUM_FLAG_SORTANDFILTER, Some(&input), Some(&output), &mut list, &mut count) }.map_err(|e| e.message())?;
        if list.is_null() {
            return Ok(None);
        }
        let activates: Vec<Option<IMFActivate>> = (0..count as usize).map(|i| unsafe { std::ptr::read(list.add(i)) }).collect();
        unsafe { CoTaskMemFree(Some(list as *const c_void)) };
        let mut last = None;
        for a in activates.into_iter().flatten() {
            let name = friendly_name(&a).unwrap_or_else(|| "hardware".into());
            let made = (|| -> windows::core::Result<MfEncoder> {
                let mft: IMFTransform = unsafe { a.ActivateObject()? };
                let attrs = unsafe { mft.GetAttributes()? };
                unsafe { attrs.SetUINT32(&MF_TRANSFORM_ASYNC_UNLOCK, 1)? };
                let events: IMFMediaEventGenerator = mft.cast()?;
                Self::configure(mft, Some(events), spec, format!("hardware ({name})"))
            })();
            match made {
                Ok(e) => return Ok(Some(e)),
                Err(e) => last = Some(format!("{name}: {}", e.message())),
            }
        }
        last.map_or(Ok(None), Err)
    }

    fn configure(mft: IMFTransform, events: Option<IMFMediaEventGenerator>, spec: &EncoderSpec, kind: String) -> windows::core::Result<MfEncoder> {
        let codec: Option<ICodecAPI> = mft.cast().ok();
        if let Some(c) = &codec {
            let mode = if spec.mode == VideoMode::Budget { eAVEncCommonRateControlMode_CBR } else { eAVEncCommonRateControlMode_UnconstrainedVBR };
            // each is the encoder's to refuse; a refusal leaves its default
            unsafe {
                let _ = c.SetValue(&CODECAPI_AVEncCommonRateControlMode, &var_u32(mode.0 as u32));
                let _ = c.SetValue(&CODECAPI_AVEncCommonMeanBitRate, &var_u32(spec.bitrate));
                let _ = c.SetValue(&CODECAPI_AVLowLatencyMode, &var_bool(true));
                let _ = c.SetValue(&CODECAPI_AVEncMPVDefaultBPictureCount, &var_u32(0));
                if c.SetValue(&CODECAPI_AVEncMPVGOPSize, &var_u32(u32::MAX)).is_err() {
                    let _ = c.SetValue(&CODECAPI_AVEncMPVGOPSize, &var_u32(0xffff));
                }
            }
        }
        let (w, h) = (spec.width as u64, spec.height as u64);
        let fps = spec.fps.max(1) as u64;
        unsafe {
            let out = MFCreateMediaType()?;
            out.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)?;
            out.SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_H264)?;
            out.SetUINT32(&MF_MT_AVG_BITRATE, spec.bitrate)?;
            out.SetUINT64(&MF_MT_FRAME_SIZE, w << 32 | h)?;
            out.SetUINT64(&MF_MT_FRAME_RATE, fps << 32 | 1)?;
            out.SetUINT64(&MF_MT_PIXEL_ASPECT_RATIO, 1 << 32 | 1)?;
            out.SetUINT32(&MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive.0 as u32)?;
            out.SetUINT32(&MF_MT_MPEG2_PROFILE, eAVEncH264VProfile_High.0 as u32)?;
            mft.SetOutputType(0, &out, 0)?;
            let inp = MFCreateMediaType()?;
            inp.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)?;
            inp.SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_NV12)?;
            inp.SetUINT64(&MF_MT_FRAME_SIZE, w << 32 | h)?;
            inp.SetUINT64(&MF_MT_FRAME_RATE, fps << 32 | 1)?;
            inp.SetUINT64(&MF_MT_PIXEL_ASPECT_RATIO, 1 << 32 | 1)?;
            inp.SetUINT32(&MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive.0 as u32)?;
            let _ = inp.SetUINT32(&MF_MT_VIDEO_NOMINAL_RANGE, MFNominalRange_16_235.0 as u32);
            let _ = inp.SetUINT32(&MF_MT_YUV_MATRIX, MFVideoTransferMatrix_BT709.0 as u32);
            let _ = inp.SetUINT32(&MF_MT_VIDEO_PRIMARIES, MFVideoPrimaries_BT709.0 as u32);
            mft.SetInputType(0, &inp, 0)?;
        }
        let mut normalizer = Normalizer::default();
        if let Some(header) = sequence_header(&mft) {
            normalizer.learn(&header);
        }
        unsafe {
            mft.ProcessMessage(MFT_MESSAGE_NOTIFY_BEGIN_STREAMING, 0)?;
            mft.ProcessMessage(MFT_MESSAGE_NOTIFY_START_OF_STREAM, 0)?;
        }
        Ok(MfEncoder { mft, codec, events, wants: 0, size: (spec.width, spec.height), fps: spec.fps.max(1), normalizer, kind })
    }

    fn sample(&self, nv12: &[u8], at_us: u64) -> windows::core::Result<IMFSample> {
        unsafe {
            let buf = MFCreateMemoryBuffer(nv12.len() as u32)?;
            let mut p: *mut u8 = std::ptr::null_mut();
            buf.Lock(&mut p, None, None)?;
            std::ptr::copy_nonoverlapping(nv12.as_ptr(), p, nv12.len());
            buf.Unlock()?;
            buf.SetCurrentLength(nv12.len() as u32)?;
            let s = MFCreateSample()?;
            s.AddBuffer(&buf)?;
            s.SetSampleTime(at_us as i64 * 10)?;
            s.SetSampleDuration(10_000_000 / self.fps as i64)?;
            Ok(s)
        }
    }

    /// One output, or None when the encoder needs more input.
    fn output(&mut self) -> windows::core::Result<Option<Encoded>> {
        for _ in 0..2 {
            let info = unsafe { self.mft.GetOutputStreamInfo(0)? };
            let provides = info.dwFlags & (MFT_OUTPUT_STREAM_PROVIDES_SAMPLES.0 as u32 | MFT_OUTPUT_STREAM_CAN_PROVIDE_SAMPLES.0 as u32) != 0;
            let mine = if provides {
                None
            } else {
                let s = unsafe { MFCreateSample()? };
                let need = (info.cbSize as usize).max(self.size.0 * self.size.1 * 2 + 4096);
                unsafe { s.AddBuffer(&MFCreateMemoryBuffer(need as u32)?)? };
                Some(s)
            };
            let mut ob = [MFT_OUTPUT_DATA_BUFFER { dwStreamID: 0, pSample: ManuallyDrop::new(mine), dwStatus: 0, pEvents: ManuallyDrop::new(None) }];
            let mut status = 0u32;
            let r = unsafe { self.mft.ProcessOutput(0, &mut ob, &mut status) };
            let sample = unsafe { ManuallyDrop::take(&mut ob[0].pSample) };
            drop(unsafe { ManuallyDrop::take(&mut ob[0].pEvents) });
            match r {
                Err(e) if e.code() == MF_E_TRANSFORM_NEED_MORE_INPUT => return Ok(None),
                Err(e) if e.code() == MF_E_TRANSFORM_STREAM_CHANGE => {
                    // the encoder settled its output type: take the one it offers, and its parameter sets
                    unsafe {
                        let t = self.mft.GetOutputAvailableType(0, 0)?;
                        self.mft.SetOutputType(0, &t, 0)?;
                    }
                    if let Some(h) = sequence_header(&self.mft) {
                        self.normalizer.learn(&h);
                    }
                    continue;
                }
                Err(e) => return Err(e),
                Ok(()) => {}
            }
            let Some(sample) = sample else { return Ok(None) };
            let bytes = unsafe {
                let buf = sample.ConvertToContiguousBuffer()?;
                let (mut p, mut len) = (std::ptr::null_mut::<u8>(), 0u32);
                buf.Lock(&mut p, None, Some(&mut len))?;
                let v = std::slice::from_raw_parts(p, len as usize).to_vec();
                buf.Unlock()?;
                v
            };
            let at = unsafe { sample.GetSampleTime() }.map(|t| (t.max(0) / 10) as u64).unwrap_or(0);
            return Ok(self.normalizer.unit(&bytes).map(|(access_unit, keyframe)| Encoded { access_unit, keyframe, at_us: at }));
        }
        Ok(None)
    }

    fn encode_sync(&mut self, sample: &IMFSample) -> windows::core::Result<Vec<Encoded>> {
        let mut out = Vec::new();
        if let Err(e) = unsafe { self.mft.ProcessInput(0, sample, 0) } {
            if e.code() != MF_E_NOTACCEPTING {
                return Err(e);
            }
            while let Some(u) = self.output()? {
                out.push(u);
            }
            unsafe { self.mft.ProcessInput(0, sample, 0)? };
        }
        while let Some(u) = self.output()? {
            out.push(u);
        }
        Ok(out)
    }

    /// An asynchronous encoder: input when it has asked for one, output each time it says it has some. Waits up to
    /// 100 ms for its ask and for the picture's output; what comes later goes out with the next picture.
    fn encode_async(&mut self, events: &IMFMediaEventGenerator, sample: &IMFSample) -> windows::core::Result<Vec<Encoded>> {
        let mut out = Vec::new();
        let mut fed = false;
        let deadline = Instant::now() + Duration::from_millis(100);
        loop {
            if !fed && self.wants > 0 {
                unsafe { self.mft.ProcessInput(0, sample, 0)? };
                self.wants -= 1;
                fed = true;
            }
            match unsafe { events.GetEvent(MF_EVENT_FLAG_NO_WAIT) } {
                Ok(ev) => {
                    let t = MF_EVENT_TYPE(unsafe { ev.GetType()? } as i32);
                    if t == METransformNeedInput {
                        self.wants += 1;
                    } else if t == METransformHaveOutput {
                        out.extend(self.output()?);
                    }
                }
                Err(e) if e.code() == MF_E_NO_EVENTS_AVAILABLE => {
                    if (fed && !out.is_empty()) || Instant::now() >= deadline {
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(1));
                }
                Err(e) => return Err(e),
            }
        }
        if !fed {
            return Err(windows::core::Error::new(E_FAIL, "the encoder asked for no input in 100 ms"));
        }
        Ok(out)
    }
}

fn friendly_name(a: &IMFActivate) -> Option<String> {
    let mut p = windows::core::PWSTR::null();
    let mut len = 0u32;
    unsafe { a.GetAllocatedString(&MFT_FRIENDLY_NAME_Attribute, &mut p, &mut len).ok()? };
    let s = unsafe { p.to_string().ok() };
    unsafe { CoTaskMemFree(Some(p.0 as *const c_void)) };
    s
}

fn sequence_header(mft: &IMFTransform) -> Option<Vec<u8>> {
    let t = unsafe { mft.GetOutputCurrentType(0).ok()? };
    let n = unsafe { t.GetBlobSize(&MF_MT_MPEG_SEQUENCE_HEADER).ok()? };
    let mut buf = vec![0u8; n as usize];
    unsafe { t.GetBlob(&MF_MT_MPEG_SEQUENCE_HEADER, &mut buf, None).ok()? };
    Some(buf)
}

impl VideoEncoder for MfEncoder {
    fn size(&self) -> (usize, usize) {
        self.size
    }

    fn encode(&mut self, nv12: &[u8], at_us: u64, keyframe: bool) -> Result<Vec<Encoded>, String> {
        if keyframe {
            if let Some(c) = &self.codec {
                let _ = unsafe { c.SetValue(&CODECAPI_AVEncVideoForceKeyFrame, &var_u32(1)) };
            }
        }
        let sample = self.sample(nv12, at_us).map_err(|e| e.message())?;
        let r = match self.events.clone() {
            Some(ev) => self.encode_async(&ev, &sample),
            None => self.encode_sync(&sample),
        };
        r.map_err(|e| e.message())
    }

    fn set_bitrate(&mut self, bits_per_second: u32) {
        if let Some(c) = &self.codec {
            let _ = unsafe { c.SetValue(&CODECAPI_AVEncCommonMeanBitRate, &var_u32(bits_per_second)) };
        }
    }

    fn kind(&self) -> String {
        self.kind.clone()
    }
}

impl Drop for MfEncoder {
    fn drop(&mut self) {
        unsafe {
            let _ = self.mft.ProcessMessage(MFT_MESSAGE_NOTIFY_END_OF_STREAM, 0);
            let _ = self.mft.ProcessMessage(MFT_MESSAGE_NOTIFY_END_STREAMING, 0);
        }
        if self.events.is_some() {
            if let Ok(s) = self.mft.cast::<IMFShutdown>() {
                let _ = unsafe { s.Shutdown() };
            }
        }
    }
}
