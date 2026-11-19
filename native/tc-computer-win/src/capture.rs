//! Window capture as the Windows service plans it (docs/computer-protocol.md
//! §6, §29.6): the shot's size and scale, downscaling, crops, the blank and
//! flatness checks that pick a format, a frame's fingerprint, the preview
//! stream's flow gate, shot file names, and base64 for inline frames.
//! Platform-free; `platform::windows` grabs the pixels and encodes them.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use crate::generated::contract::{preview, shot};
use crate::wire::{CoordinateSpace, ShotFormat};

/// Pixels as the platform grabbed them: 8-bit BGR, rows top to bottom, no padding.
#[derive(Debug, Clone, PartialEq)]
pub struct Image {
    pub width: usize,
    pub height: usize,
    pub bgr: Vec<u8>,
}

impl Image {
    pub fn new(width: usize, height: usize) -> Self {
        Image { width, height, bgr: vec![0; width * height * 3] }
    }

    pub fn px(&self, x: usize, y: usize) -> [u8; 3] {
        let i = (y * self.width + x) * 3;
        [self.bgr[i], self.bgr[i + 1], self.bgr[i + 2]]
    }

    /// The rectangle `[x0, y0, x1, y1)`, clipped to the image.
    pub fn crop(&self, x0: usize, y0: usize, x1: usize, y1: usize) -> Image {
        let (x1, y1) = (x1.min(self.width), y1.min(self.height));
        let (x0, y0) = (x0.min(x1), y0.min(y1));
        let w = x1 - x0;
        let mut out = Vec::with_capacity(w * (y1 - y0) * 3);
        for y in y0..y1 {
            let row = (y * self.width + x0) * 3;
            out.extend_from_slice(&self.bgr[row..row + w * 3]);
        }
        Image { width: w, height: y1 - y0, bgr: out }
    }

    /// Area-averaged to `w × h` (never up).
    pub fn scaled(&self, w: usize, h: usize) -> Image {
        let (w, h) = (w.clamp(1, self.width.max(1)), h.clamp(1, self.height.max(1)));
        if w == self.width && h == self.height {
            return self.clone();
        }
        let mut out = Image::new(w, h);
        let (sx, sy) = (self.width as f64 / w as f64, self.height as f64 / h as f64);
        for oy in 0..h {
            let (y0, y1) = ((oy as f64 * sy) as usize, (((oy + 1) as f64 * sy).ceil() as usize).min(self.height));
            for ox in 0..w {
                let (x0, x1) = ((ox as f64 * sx) as usize, (((ox + 1) as f64 * sx).ceil() as usize).min(self.width));
                let mut sum = [0u32; 3];
                let mut n = 0u32;
                for y in y0..y1.max(y0 + 1) {
                    for x in x0..x1.max(x0 + 1) {
                        let p = self.px(x.min(self.width - 1), y.min(self.height - 1));
                        for c in 0..3 {
                            sum[c] += p[c] as u32;
                        }
                        n += 1;
                    }
                }
                let i = (oy * w + ox) * 3;
                for c in 0..3 {
                    out.bgr[i + c] = ((sum[c] + n / 2) / n) as u8;
                }
            }
        }
        out
    }
}

/// The shot's scale of a `w × h` window (§6 `ShotGeometry`): `min(1, maxEdge / longEdge, sqrt(maxPixels / pixels))`,
/// one scale for both axes, each side floored once and never 0.
pub fn geometry(w: f64, h: f64, max_edge: Option<i64>) -> CoordinateSpace {
    let edge = max_edge.unwrap_or(shot::DEFAULT_MAX_EDGE).clamp(shot::MIN_MAX_EDGE, shot::MAX_MAX_EDGE) as f64;
    let (w, h) = (w.max(1.0), h.max(1.0));
    let scale = 1f64.min(edge / w.max(h)).min((shot::MAX_PIXELS as f64 / (w * h)).sqrt());
    CoordinateSpace { width: ((w * scale).floor() as i64).max(1), height: ((h * scale).floor() as i64).max(1), scale }
}

/// A preview frame's size: the window fitted to the stream's long edge, never up.
pub fn fitted(w: usize, h: usize, max_edge: Option<i64>) -> (usize, usize) {
    let edge = max_edge.unwrap_or(preview::DEFAULT_MAX_EDGE).clamp(preview::MIN_MAX_EDGE, shot::MAX_MAX_EDGE) as f64;
    let k = 1f64.min(edge / (w.max(h).max(1) as f64));
    (((w as f64 * k).floor() as usize).max(1), ((h as f64 * k).floor() as usize).max(1))
}

/// A window the compositor has not drawn: every channel spans at most 3 levels.
pub fn blank(img: &Image) -> bool {
    let (mut lo, mut hi) = ([255u8; 3], [0u8; 3]);
    for p in img.bgr.chunks_exact(3) {
        for c in 0..3 {
            lo[c] = lo[c].min(p[c]);
            hi[c] = hi[c].max(p[c]);
        }
    }
    img.bgr.is_empty() || (0..3).all(|c| hi[c].saturating_sub(lo[c]) <= 3)
}

/// On every 4th row, the share of pixels within 2 levels of their right neighbour (§6, A1).
pub fn flatness(img: &Image) -> f64 {
    let (mut same, mut all) = (0u64, 0u64);
    for y in (0..img.height).step_by(4) {
        for x in 0..img.width.saturating_sub(1) {
            let (a, b) = (img.px(x, y), img.px(x + 1, y));
            all += 1;
            if (0..3).all(|c| a[c].abs_diff(b[c]) <= 2) {
                same += 1;
            }
        }
    }
    if all == 0 { 1.0 } else { same as f64 / all as f64 }
}

/// With no format named: JPEG; for a flat image PNG too, kept when no larger (§6, A1).
pub fn try_png_too(img: &Image) -> bool {
    flatness(img) >= 0.85
}

/// A cheap fingerprint of a frame's pixels and size: a frame is sent only when it differs from the last.
pub fn fingerprint(img: &Image) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325 ^ ((img.width as u64) << 32 | img.height as u64);
    // every 2nd pixel of every 2nd row: a caret blink or one changed glyph still moves it
    for y in (0..img.height).step_by(2) {
        let row = y * img.width * 3;
        for x in (0..img.width).step_by(2) {
            let i = row + x * 3;
            for c in 0..3 {
                h ^= img.bgr[i + c] as u64;
                h = h.wrapping_mul(0x100_0000_01b3);
            }
        }
    }
    h
}

/// The stream's flow control (§6 `FrameGate`): at most `MAX_UNACKED` frames out without an ack, a newer
/// frame replacing the held one, and capture paused while a frame waits 5 s for its ack.
#[derive(Debug, Default)]
pub struct FrameGate {
    /// seq of each frame sent and not yet acked, oldest first, with when it went
    out: Vec<(i64, Instant)>,
    pub next_seq: i64,
}

pub const STARVE: Duration = Duration::from_secs(5);

impl FrameGate {
    /// Whether a frame may go now; if so its seq.
    pub fn take(&mut self, now: Instant) -> Option<i64> {
        if self.out.len() >= preview::MAX_UNACKED as usize {
            return None;
        }
        self.next_seq += 1;
        self.out.push((self.next_seq, now));
        Some(self.next_seq)
    }

    /// An ack covers its frame and every earlier one; one for a frame never sent is ignored.
    pub fn ack(&mut self, seq: i64) {
        if seq <= self.next_seq {
            self.out.retain(|(s, _)| *s > seq);
        }
    }

    /// A frame that was never sent (over the size cap): its place freed, no other frame's.
    pub fn drop_frame(&mut self, seq: i64) {
        self.out.retain(|(s, _)| *s != seq);
    }

    /// A frame has waited STARVE for its ack: stop capturing until one comes.
    pub fn starved(&self, now: Instant) -> bool {
        self.out.first().is_some_and(|(_, at)| now.duration_since(*at) >= STARVE)
    }
}

/// Shot files (§6, A2): `<dataDir>/shots/<session>/<nnnn>-<action>`, numbered above the highest file already there.
pub fn shot_dir(data_dir: &Path, session: &str) -> PathBuf {
    let safe: String = session.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' }).collect();
    data_dir.join("shots").join(safe)
}

/// The next number in a shot directory.
pub fn next_number(dir: &Path) -> u64 {
    let highest = std::fs::read_dir(dir)
        .map(|rd| rd.filter_map(|e| e.ok()?.file_name().to_str()?.split('-').next()?.parse::<u64>().ok()).max().unwrap_or(0))
        .unwrap_or(0);
    highest + 1
}

/// The stem's name: four digits (more past 9999), then the action lower-cased, anything outside `[a-z0-9_]` made `_`.
pub fn stem_name(n: u64, action: &str) -> String {
    let word: String = action.to_lowercase().chars().map(|c| if c.is_ascii_alphanumeric() || c == '_' { c } else { '_' }).collect();
    format!("{n:04}-{word}")
}

/// Writes the bytes beside their name, then moves them on, never replacing a shot.
pub fn write_shot(dir: &Path, stem: &str, format: ShotFormat, bytes: &[u8]) -> std::io::Result<PathBuf> {
    std::fs::create_dir_all(dir)?;
    let ext = if format == ShotFormat::Png { "png" } else { "jpg" };
    let path = dir.join(format!("{stem}.{ext}"));
    let tmp = dir.join(format!(".{stem}.{ext}.part"));
    std::fs::write(&tmp, bytes)?;
    // a hard link fails on an existing name, so a shot is never replaced
    let linked = std::fs::hard_link(&tmp, &path);
    let _ = std::fs::remove_file(&tmp);
    linked.map(|_| path)
}

/// Standard base64, padded.
pub fn base64(bytes: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for c in bytes.chunks(3) {
        let n = (c[0] as u32) << 16 | (*c.get(1).unwrap_or(&0) as u32) << 8 | *c.get(2).unwrap_or(&0) as u32;
        out.push(T[(n >> 18) as usize & 63] as char);
        out.push(T[(n >> 12) as usize & 63] as char);
        out.push(if c.len() > 1 { T[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if c.len() > 2 { T[n as usize & 63] as char } else { '=' });
    }
    out
}

/// A frame's JPEG qualities, tried in turn to stay under the line cap with its JSON (§6).
pub const FRAME_QUALITIES: [f32; 3] = [0.85, 0.7, 0.55];
/// A frame's JPEG must stay under this (the base64 line with its JSON fits `FRAME_MAX_BYTES`).
pub const FRAME_JPEG_MAX: usize = 380 * 1024;

#[cfg(test)]
mod tests {
    use super::*;

    fn checker(w: usize, h: usize) -> Image {
        let mut img = Image::new(w, h);
        for y in 0..h {
            for x in 0..w {
                let v = if (x + y) % 2 == 0 { 255 } else { 0 };
                let i = (y * w + x) * 3;
                img.bgr[i..i + 3].copy_from_slice(&[v, v, v]);
            }
        }
        img
    }

    #[test]
    fn a_shot_is_never_upscaled_and_keeps_to_the_long_edge_and_the_pixel_cap() {
        let s = geometry(800.0, 600.0, None);
        assert_eq!((s.width, s.height, s.scale), (800, 600, 1.0));
        let s = geometry(2560.0, 1440.0, None);
        assert_eq!(s.width, 1280);
        assert_eq!(s.height, 720);
        let s = geometry(2560.0, 1440.0, Some(2576));
        assert!(s.width * s.height <= 3_750_000);
        assert_eq!(geometry(4000.0, 1.0, Some(100)).width, 512, "maxEdge is clamped to the wire's minimum");
        assert_eq!(fitted(1920, 1080, None), (960, 540));
        assert_eq!(fitted(300, 200, None), (300, 200));
    }

    #[test]
    fn crops_and_downscales_average_the_pixels() {
        let img = checker(4, 4);
        let half = img.scaled(2, 2);
        assert_eq!(half.px(0, 0), [128, 128, 128]);
        let c = img.crop(1, 1, 3, 9);
        assert_eq!((c.width, c.height), (2, 3));
        assert_eq!(c.px(0, 0), img.px(1, 1));
    }

    #[test]
    fn blank_and_flat_are_read_from_the_pixels() {
        let mut img = Image::new(10, 10);
        assert!(blank(&img));
        assert_eq!(flatness(&img), 1.0);
        img.bgr[0] = 200;
        assert!(!blank(&img));
        assert!(flatness(&checker(16, 16)) < 0.1);
        assert!(!try_png_too(&checker(16, 16)));
    }

    #[test]
    fn a_changed_pixel_or_size_changes_the_fingerprint() {
        let a = Image::new(20, 20);
        let mut b = a.clone();
        b.bgr[(2 * 20 + 2) * 3] = 9;
        assert_ne!(fingerprint(&a), fingerprint(&b));
        assert_ne!(fingerprint(&Image::new(20, 21)), fingerprint(&a));
        assert_eq!(fingerprint(&a), fingerprint(&a.clone()));
    }

    #[test]
    fn the_gate_holds_two_frames_out_and_starves_after_five_seconds() {
        let t = Instant::now();
        let mut g = FrameGate::default();
        assert_eq!(g.take(t), Some(1));
        assert_eq!(g.take(t), Some(2));
        assert_eq!(g.take(t), None);
        g.ack(99); // never sent: ignored
        assert_eq!(g.take(t), None);
        g.drop_frame(2); // never sent: 1 is still out
        assert_eq!(g.take(t), Some(3));
        assert_eq!(g.take(t), None);
        g.ack(3); // covers 1 too
        assert_eq!(g.take(t), Some(4));
        assert!(!g.starved(t + Duration::from_secs(4)));
        assert!(g.starved(t + STARVE));
    }

    #[test]
    fn shots_are_numbered_above_the_highest_and_never_replaced() {
        let dir = std::env::temp_dir().join(format!("tc-shot-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let shots = shot_dir(&dir, "s/1");
        assert!(shots.ends_with("shots/s_1"));
        assert_eq!(next_number(&shots), 1);
        let p = write_shot(&shots, &stem_name(7, "left_click"), ShotFormat::Png, b"x").unwrap();
        assert!(p.ends_with("0007-left_click.png"));
        assert!(write_shot(&shots, &stem_name(7, "left_click"), ShotFormat::Png, b"y").is_err());
        assert_eq!(std::fs::read(&p).unwrap(), b"x");
        assert_eq!(next_number(&shots), 8);
        assert_eq!(stem_name(12345, "Zoom In!"), "12345-zoom_in_");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn base64_matches_the_standard_alphabet() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foobar"), "Zm9vYmFy");
        assert_eq!(base64(&[0xff, 0xfe, 0xfd]), "//79");
    }
}
