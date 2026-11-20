//! A video stream's pictures (docs/computer-protocol.md §30): the size a
//! window is encoded at, and the capture's BGRA as the encoder's NV12 at that
//! size (BT.709, limited range, each output pixel the mean of the pixels it
//! covers). Pure.

use std::sync::Arc;

/// One picture from the capture: 8-bit BGRA rows, top to bottom, `stride` bytes apart.
#[derive(Debug, Clone)]
pub struct Picture {
    pub width: usize,
    pub height: usize,
    pub stride: usize,
    pub bgra: Arc<Vec<u8>>,
    /// when the capture took it, in µs on the service's monotonic clock
    pub at_us: u64,
}

impl Picture {
    /// A picture of one colour, for tests and fakes.
    pub fn solid(width: usize, height: usize, bgra: [u8; 4], at_us: u64) -> Self {
        Picture { width, height, stride: width * 4, bgra: Arc::new(bgra.repeat(width * height)), at_us }
    }
}

/// The window's own pixels scaled down to fit `max_edge` on the long edge, never up, each side even (H.264's
/// 4:2:0 needs it) and at least 2 (`VideoGeometry.picture` on the Mac).
pub fn picture_size(width: usize, height: usize, max_edge: usize) -> (usize, usize) {
    let (w, h) = (width.max(1) as f64, height.max(1) as f64);
    let k = 1f64.min(max_edge as f64 / w.max(h));
    let even = |v: f64| ((v.floor() as usize) & !1).max(2);
    (even(w * k), even(h * k))
}

/// For each output index, the source range it covers when `src` is scaled to `dst` (never empty).
fn spans(src: usize, dst: usize) -> Vec<(usize, usize)> {
    (0..dst)
        .map(|i| {
            let a = i * src / dst;
            let b = ((i + 1) * src).div_ceil(dst).min(src);
            (a, b.max(a + 1).min(src.max(1)))
        })
        .collect()
}

/// The picture as NV12 of `w × h` (both even): `w × h` bytes of Y, then `w × h / 2` of interleaved Cb, Cr.
pub fn to_nv12(p: &Picture, w: usize, h: usize) -> Vec<u8> {
    let mut out = vec![0u8; w * h * 3 / 2];
    if p.width == 0 || p.height == 0 {
        return out;
    }
    let (xs, ys) = (spans(p.width, w), spans(p.height, h));
    // the mean BGR of each output pixel of two rows at a time, then Y for each and one Cb, Cr per 2×2
    let mut rows = [vec![[0u32; 3]; w], vec![[0u32; 3]; w]];
    let same = p.width == w && p.height == h;
    for y2 in (0..h).step_by(2) {
        for (r, row) in rows.iter_mut().enumerate() {
            let y = y2 + r;
            if same {
                let line = &p.bgra[y * p.stride..y * p.stride + w * 4];
                for (x, px) in row.iter_mut().enumerate() {
                    *px = [line[x * 4] as u32, line[x * 4 + 1] as u32, line[x * 4 + 2] as u32];
                }
                continue;
            }
            let (y0, y1) = ys[y];
            for (x, px) in row.iter_mut().enumerate() {
                let (x0, x1) = xs[x];
                let mut sum = [0u32; 3];
                for sy in y0..y1 {
                    let line = &p.bgra[sy * p.stride..];
                    for sx in x0..x1 {
                        sum[0] += line[sx * 4] as u32;
                        sum[1] += line[sx * 4 + 1] as u32;
                        sum[2] += line[sx * 4 + 2] as u32;
                    }
                }
                let n = ((y1 - y0) * (x1 - x0)) as u32;
                *px = [(sum[0] + n / 2) / n, (sum[1] + n / 2) / n, (sum[2] + n / 2) / n];
            }
        }
        for (r, row) in rows.iter().enumerate() {
            let line = &mut out[(y2 + r) * w..(y2 + r + 1) * w];
            for (x, [b, g, rr]) in row.iter().enumerate() {
                line[x] = luma(*rr as i32, *g as i32, *b as i32);
            }
        }
        let chroma = &mut out[w * h + (y2 / 2) * w..w * h + (y2 / 2 + 1) * w];
        for x2 in (0..w).step_by(2) {
            let mut s = [0i32; 3];
            for px in [rows[0][x2], rows[0][x2 + 1], rows[1][x2], rows[1][x2 + 1]] {
                for c in 0..3 {
                    s[c] += px[c] as i32;
                }
            }
            let (b, g, r) = ((s[0] + 2) / 4, (s[1] + 2) / 4, (s[2] + 2) / 4);
            chroma[x2] = cb(r, g, b);
            chroma[x2 + 1] = cr(r, g, b);
        }
    }
    out
}

// BT.709, limited range, in 1/256ths
fn luma(r: i32, g: i32, b: i32) -> u8 {
    (16 + ((47 * r + 157 * g + 16 * b + 128) >> 8)).clamp(16, 235) as u8
}

fn cb(r: i32, g: i32, b: i32) -> u8 {
    (128 + ((-26 * r - 86 * g + 112 * b + 128) >> 8)).clamp(16, 240) as u8
}

fn cr(r: i32, g: i32, b: i32) -> u8 {
    (128 + ((112 * r - 102 * g - 10 * b + 128) >> 8)).clamp(16, 240) as u8
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_picture_fits_max_edge_never_grows_and_is_even() {
        assert_eq!(picture_size(2560, 1600, 1001), (1000, 624));
        assert_eq!(picture_size(2560, 1600, 3840), (2560, 1600));
        assert_eq!(picture_size(2560, 1600, 1280), (1280, 800));
        assert_eq!(picture_size(1001, 333, 3840), (1000, 332));
        assert_eq!(picture_size(1, 1, 3840), (2, 2));
        assert_eq!(picture_size(4000, 3, 256), (256, 2));
    }

    #[test]
    fn colours_become_bt709_limited_range() {
        let nv12 = |bgra: [u8; 4]| to_nv12(&Picture::solid(4, 2, bgra, 0), 4, 2);
        // white, black, red: Y and the first Cb, Cr
        let white = nv12([255, 255, 255, 255]);
        assert_eq!((white[0], white[8], white[9]), (235, 128, 128));
        let black = nv12([0, 0, 0, 255]);
        assert_eq!((black[0], black[8], black[9]), (16, 128, 128));
        let red = nv12([0, 0, 255, 255]);
        assert_eq!((red[0], red[8], red[9]), (63, 102, 240));
        assert_eq!(red.len(), 4 * 2 * 3 / 2);
    }

    #[test]
    fn a_smaller_picture_takes_the_mean_of_what_it_covers() {
        // 4×4: the left half black, the right half white, to 2×2
        let mut bgra = vec![0u8; 4 * 4 * 4];
        for y in 0..4 {
            for x in 2..4 {
                bgra[(y * 4 + x) * 4..(y * 4 + x) * 4 + 4].copy_from_slice(&[255; 4]);
            }
        }
        let p = Picture { width: 4, height: 4, stride: 16, bgra: Arc::new(bgra), at_us: 0 };
        let out = to_nv12(&p, 2, 2);
        assert_eq!(&out[..4], &[16, 235, 16, 235]);
        // the chroma of the 2×2 block is grey's
        assert_eq!(&out[4..], &[128, 128]);
        // a stride wider than the row is read past
        let mut wide = vec![9u8; 6 * 4 * 2];
        for y in 0..2 {
            wide[y * 24..y * 24 + 16].copy_from_slice(&[255; 16]);
        }
        let p = Picture { width: 4, height: 2, stride: 24, bgra: Arc::new(wide), at_us: 0 };
        assert!(to_nv12(&p, 4, 2)[..8].iter().all(|y| *y == 235));
    }
}
