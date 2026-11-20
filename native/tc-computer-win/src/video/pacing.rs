//! The pacer and the still window of a video stream (docs/computer-protocol.md
//! §30), as `VideoPacing.swift` has them on the Mac. Pure; times in µs.

use std::collections::VecDeque;

use crate::generated::contract::video;

/// Drops a capture running at the display's own rate to a stream's `fps`. Of the frames that come it keeps the
/// one nearest each slot of an even 1/fps grid: a frame half a slot early is taken and the grid moves on by one
/// slot, or restarts from a late frame. No more than `fps` frames are taken in any second.
#[derive(Debug, Clone)]
pub struct FramePacer {
    pub fps: usize,
    interval: f64,
    next: Option<f64>,
    /// the last `fps` frames taken, oldest first
    taken: VecDeque<u64>,
}

impl FramePacer {
    pub fn new(fps: usize) -> Self {
        let fps = fps.max(1);
        FramePacer { fps, interval: 1_000_000.0 / fps as f64, next: None, taken: VecDeque::with_capacity(fps) }
    }

    /// Whether the frame captured at `at_us` is one to keep; a kept frame counts.
    pub fn take(&mut self, at_us: u64) -> bool {
        let (at, slack) = (at_us as f64, self.interval / 2.0);
        if self.next.is_some_and(|next| at + slack < next) {
            return false;
        }
        if self.taken.len() == self.fps && self.taken.front().is_some_and(|oldest| at_us < oldest + 1_000_000) {
            return false;
        }
        self.next = Some((self.next.unwrap_or(at) + self.interval).max(at + self.interval - slack));
        if self.taken.len() == self.fps {
            self.taken.pop_front();
        }
        self.taken.push_back(at_us);
        true
    }
}

/// A still window: once the capture has had no new picture for `after`, the last picture is encoded again, one
/// frame interval apart, up to `frames` times, so the picture left on the viewer's screen is sharp; then
/// nothing until a new picture comes.
#[derive(Debug, Clone)]
pub struct StillWindow {
    after_us: u64,
    frames: usize,
    interval_us: u64,
    last_picture_us: Option<u64>,
    last_ask_us: u64,
    pub repeats: usize,
}

impl StillWindow {
    pub fn new(fps: usize) -> Self {
        Self::with(fps, video::SHARPEN_AFTER_MS as u64, video::SHARPEN_FRAMES as usize)
    }

    pub fn with(fps: usize, after_ms: u64, frames: usize) -> Self {
        StillWindow { after_us: after_ms * 1000, frames, interval_us: 1_000_000 / fps.max(1) as u64, last_picture_us: None, last_ask_us: 0, repeats: 0 }
    }

    /// A new picture came from the capture, sent or not.
    pub fn picture(&mut self, at_us: u64) {
        self.last_picture_us = Some(at_us);
        self.repeats = 0;
    }

    /// Whether the last picture should be encoded again now; true marks the ask, so the next waits an interval.
    pub fn due(&mut self, at_us: u64) -> bool {
        let Some(last) = self.last_picture_us else { return false };
        if self.repeats >= self.frames || at_us < last + self.after_us || at_us < self.last_ask_us + self.interval_us {
            return false;
        }
        self.last_ask_us = at_us;
        true
    }

    /// The repeat was taken for encoding.
    pub fn repeated(&mut self) {
        self.repeats += 1;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The frames `hz` a second for `seconds`, each moved by `jitter(i)` µs, and the ones the pacer kept.
    fn run(fps: usize, hz: f64, jitter: impl FnMut(usize) -> f64) -> (Vec<u64>, Vec<u64>) {
        let mut jitter = jitter;
        let mut pacer = FramePacer::new(fps);
        let count = (hz * 10.0) as usize;
        let offered: Vec<u64> = (0..count).map(|i| (1_000_000.0 + i as f64 * 1_000_000.0 / hz + jitter(i)).max(0.0).round() as u64).collect();
        let kept = offered.iter().copied().filter(|at| pacer.take(*at)).collect();
        (offered, kept)
    }

    /// The most frames in any second.
    fn busiest_second(kept: &[u64]) -> usize {
        let (mut most, mut from) = (0, 0);
        for (i, at) in kept.iter().enumerate() {
            while kept[from] + 1_000_000 <= *at {
                from += 1;
            }
            most = most.max(i - from + 1);
        }
        most
    }

    #[test]
    fn a_hundred_forty_four_come_and_an_even_hundred_twenty_go() {
        let (offered, kept) = run(120, 144.0, |_| 0.0);
        assert!((kept.len() as i64 - 1200).abs() <= 1, "{}", kept.len());
        assert!(busiest_second(&kept) <= 120);
        // even: five of every six, never two dropped in a row
        let input = 1_000_000.0 / 144.0;
        let gaps: Vec<f64> = kept.windows(2).map(|w| (w[1] - w[0]) as f64).collect();
        assert!(gaps.iter().all(|g| *g < 2.0 * input + 2.0));
        assert!(gaps.iter().filter(|g| **g > 1.5 * input).count() <= offered.len() / 6 + 1);
    }

    #[test]
    fn every_frame_at_the_asked_rate_or_below_is_kept() {
        assert_eq!(run(120, 120.0, |_| 0.0).1.len(), 1200);
        assert_eq!(run(120, 60.0, |_| 0.0).1.len(), 600);
        assert_eq!(run(60, 60.0, |_| 0.0).1.len(), 600);
        // a millisecond's jitter either way changes nothing
        let (offered, kept) = run(120, 120.0, |i| if i % 2 == 0 { 1000.0 } else { -1000.0 });
        assert_eq!(kept.len(), offered.len());
    }

    #[test]
    fn never_more_than_the_rate_in_any_second() {
        let mut seed: u64 = 7;
        for (fps, hz) in [(120, 240.0), (120, 165.0), (60, 144.0), (30, 120.0), (10, 60.0)] {
            let (_, mut kept) = run(fps, hz, |_| {
                seed = seed.wrapping_mul(6_364_136_223_846_793_005).wrapping_add(1_442_695_040_888_963_407);
                (seed >> 40) as f64 / (1u64 << 24) as f64 * 3000.0 - 1500.0
            });
            kept.sort();
            assert!(busiest_second(&kept) <= fps);
            assert!(kept.len() >= fps * 9);
        }
    }

    #[test]
    fn a_still_picture_is_sent_again_four_times_then_nothing() {
        let mut still = StillWindow::new(120);
        assert!(!still.due(1_000_000), "nothing yet to send again");
        still.picture(1_000_000);
        assert!(!still.due(1_149_999));
        let mut asks = Vec::new();
        for at in (1_150_000..2_000_000).step_by(1000) {
            if still.due(at) {
                asks.push(at);
                still.repeated();
            }
        }
        assert_eq!(asks.len(), 4);
        assert_eq!(asks[0], 1_150_000);
        assert!(asks.windows(2).all(|w| w[1] - w[0] >= 8_333));
        assert!(!still.due(9_000_000));
        // the window changed: the rule starts again from the new picture
        still.picture(9_000_000);
        assert!(!still.due(9_100_000));
        assert!(still.due(9_150_000));
    }

    #[test]
    fn a_repeat_the_flow_refused_is_asked_again() {
        let mut still = StillWindow::new(60);
        still.picture(0);
        assert!(still.due(150_000));
        assert!(!still.due(151_000), "one interval between asks");
        assert!(still.due(166_667));
        for _ in 0..4 {
            still.repeated();
        }
        assert!(!still.due(400_000));
    }

    #[test]
    fn a_moving_window_is_never_repeated() {
        let mut still = StillWindow::new(120);
        for at in (0..2_000_000).step_by(8_333) {
            still.picture(at);
            assert!(!still.due(at + 4000));
        }
    }
}
