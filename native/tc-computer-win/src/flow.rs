//! Ported from screen-relay 0.1.2 (github.com/vercel-labs/screen-relay, `src/engine/core/flow.hpp`),
//! licensed under the Apache License, Version 2.0 (http://www.apache.org/licenses/LICENSE-2.0).
//! Changed here: C++ to Rust, names in Rust's snake case, the unsigned sums that may wrap in C++ written
//! with `wrapping_add` and `wrapping_sub` so they wrap the same way, and `Pressure` ordered for its `>=`.
//! The rules, the numbers and the TCP-statistics path are as they were; the Windows service has no TCP
//! statistics on its named pipe and runs the path without them. The tests below hold every case of its
//! flow test.

use std::collections::VecDeque;

/// C++'s `std::clamp`: the low bound wins below it, the high bound above it.
fn clamp_u64(value: u64, low: u64, high: u64) -> u64 {
    if value < low {
        low
    } else if high < value {
        high
    } else {
        value
    }
}

fn clamp_f64(value: f64, low: f64, high: f64) -> f64 {
    if value < low {
        low
    } else if high < value {
        high
    } else {
        value
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Pressure {
    Clear,
    Building,
    Congested,
    Paused,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct TransportSample {
    pub min_rtt_us: u64,
    pub rtt_us: u64,
    pub delivery_rate_bps: u64,
    pub notsent_bytes: u64,
    pub bytes_acked: u64,
    pub application_queued_bytes: u64,
    pub snd_cwnd: u32,
    pub total_retrans: u32,
    pub app_limited: bool,
}

#[derive(Clone, Copy, Debug)]
struct DeliverySample {
    time_us: u64,
    rate_bps: u64,
}

#[derive(Clone, Copy, Debug)]
struct ExtremeSample {
    time_us: u64,
    value: u64,
}

/// Sliding-window extreme of timestamped values: keep a span, read the smallest (or largest) value over any shorter trailing window.
#[derive(Clone, Debug)]
struct WindowExtreme {
    samples: VecDeque<ExtremeSample>,
    smallest: bool,
    forgotten_us: u64,
}

impl WindowExtreme {
    fn smallest() -> Self {
        WindowExtreme { samples: VecDeque::new(), smallest: true, forgotten_us: 0 }
    }

    fn largest() -> Self {
        WindowExtreme { samples: VecDeque::new(), smallest: false, forgotten_us: 0 }
    }

    fn push(&mut self, now: u64, value: u64, span_us: u64) {
        while self.samples.front().is_some_and(|s| now - now.min(s.time_us) >= span_us) {
            self.samples.pop_front();
        }
        while self.samples.back().is_some_and(|s| if self.smallest { s.value >= value } else { s.value <= value }) {
            self.samples.pop_back();
        }
        self.samples.push_back(ExtremeSample { time_us: now, value });
    }

    fn is_empty(&self) -> bool {
        self.samples.is_empty()
    }

    fn overall(&self, none: u64) -> u64 {
        self.samples.front().map_or(none, |s| s.value)
    }

    /// Makes later reads over a window ignore anything older than `window_us` before `now`, even if a longer window is read later.
    fn forget(&mut self, now: u64, window_us: u64) {
        self.forgotten_us = self.forgotten_us.max(now - now.min(window_us));
    }

    fn over(&self, now: u64, window_us: u64, none: u64, floor_us: u64) -> u64 {
        for sample in &self.samples {
            if sample.time_us > self.forgotten_us.max(floor_us) && now - now.min(sample.time_us) < window_us {
                return sample.value;
            }
        }
        none
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Frame {
    pub sequence: u32,
    pub bytes: usize,
    pub captured_us: u64,
    pub sent: bool,
    pub sent_us: u64,
}

/// One video stream's flow control: the window of frames sent and not acked, the pause, the bitrate the
/// acks and the viewer's wait move, and the timeout. All times are server steady-clock microseconds; the
/// service thread owns this state.
#[derive(Clone, Debug)]
pub struct FlowControl {
    depth: WindowExtreme,
    network: WindowExtreme,
    peak: WindowExtreme,
    held: WindowExtreme,
    /// Age of the oldest unacknowledged frame, sampled on service ticks; lets a stall be seen while no acknowledgements arrive.
    waiting: WindowExtreme,
    pub transport: TransportSample,
    pub transport_available: bool,
    pub delivery_rate_bps: u64,
    last_transport_update_us: u64,
    delivery_samples: VecDeque<DeliverySample>,
    pub min_bitrate: u64,
    pub initial_bitrate: u64,
    pub max_bitrate: u64,
    pub frames: VecDeque<Frame>,
    pub bytes: usize,
    /// Largest frame this generation; capture pauses while the byte budget left could not hold one, since enqueue rejects a frame that does not fit and the server then closes the stream.
    pub largest_frame: usize,
    pub last_encoded: u32,
    pub acknowledged: u64,
    pub encoded: u64,
    pub last_progress_us: u64,
    pub target_bitrate: u64,
    /// Smoothed send-to-acknowledgement time; reported by /metrics only.
    pub ack_rtt_us: f64,
    pub window: u32,
    sample_start_us: u64,
    sample_bytes: u64,
    sample_acks: u64,
    previous_sent_us: u64,
    last_decrease_us: u64,
    last_increase_us: u64,
    /// Rate measured over the last busy sample; reported by /metrics, and caps a cut.
    pub goodput_bps: f64,
    pub frame_rate: u32,
}

impl Default for FlowControl {
    fn default() -> Self {
        FlowControl {
            depth: WindowExtreme::smallest(),
            network: WindowExtreme::smallest(),
            peak: WindowExtreme::largest(),
            held: WindowExtreme::largest(),
            waiting: WindowExtreme::smallest(),
            transport: TransportSample::default(),
            transport_available: false,
            delivery_rate_bps: 0,
            last_transport_update_us: 0,
            delivery_samples: VecDeque::new(),
            min_bitrate: 1_000_000,
            initial_bitrate: 8_000_000,
            max_bitrate: 40_000_000,
            frames: VecDeque::new(),
            bytes: 0,
            largest_frame: 0,
            last_encoded: 0,
            acknowledged: 0,
            encoded: 0,
            last_progress_us: 0,
            target_bitrate: 8_000_000,
            ack_rtt_us: 0.0,
            window: 1,
            sample_start_us: 0,
            sample_bytes: 0,
            sample_acks: 0,
            previous_sent_us: 0,
            last_decrease_us: 0,
            last_increase_us: 0,
            goodput_bps: 0.0,
            frame_rate: 60,
        }
    }
}

impl FlowControl {
    pub const MAX_BYTES: usize = 8 * 1024 * 1024;
    pub const PAUSE_AGE_US: u64 = 250_000;
    pub const TIMEOUT_US: u64 = 3_000_000;
    pub const MAX_FRAMES: usize = (Self::TIMEOUT_US * 120 / 1_000_000) as usize;
    pub const BASE_WINDOW_US: u64 = 10_000_000;
    pub const VIEWER_HOLD_LIMIT_US: u64 = 100_000;
    pub const DELIVERY_WINDOW_US: u64 = 1_000_000;
    pub const BITRATE_SMOOTHING_US: u64 = 500_000;
    pub const SAMPLE_INTERVAL_US: u64 = 10_000;
    pub const IDLE_SAMPLE_INTERVAL_US: u64 = 100_000;

    /// Applies the configured bitrate limits and starts at the configured initial rate.
    pub fn configure(&mut self, minimum: u64, initial: u64, maximum: u64, fps: u32) {
        self.min_bitrate = minimum;
        self.initial_bitrate = initial;
        self.max_bitrate = maximum;
        self.target_bitrate = initial;
        self.frame_rate = fps.max(1);
    }

    /// Restores the idle transport state while keeping the configured bitrate limits.
    pub fn reset(&mut self) {
        let (minimum, initial, maximum, fps) = (self.min_bitrate, self.initial_bitrate, self.max_bitrate, self.frame_rate);
        *self = FlowControl::default();
        self.configure(minimum, initial, maximum, fps);
    }

    /// Reads the viewer wait from an acknowledgement payload: 4 bytes of big-endian microseconds, or zero when absent or malformed.
    pub fn ack_wait_us(payload: &[u8]) -> u64 {
        match payload {
            [a, b, c, d] => (u64::from(*a) << 24) | (u64::from(*b) << 16) | (u64::from(*c) << 8) | u64::from(*d),
            _ => 0,
        }
    }

    pub fn oldest_age(&self, now: u64) -> u64 {
        self.frames.front().map_or(0, |f| now - now.min(f.captured_us))
    }

    pub fn frame_interval_us(&self) -> u64 {
        (1_000_000 + u64::from(self.frame_rate) - 1) / u64::from(self.frame_rate)
    }

    pub fn service_deadline_us(&self, now: u64, pending: u64) -> u64 {
        let next = now + if self.frames.is_empty() { Self::IDLE_SAMPLE_INTERVAL_US } else { Self::SAMPLE_INTERVAL_US };
        if pending != 0 {
            pending.min(next)
        } else {
            next
        }
    }

    /// Capture-to-acknowledgement time of an uncongested frame: the network base plus the viewer's wait, so a hold the viewer adds is not read as queue; zero when unmeasured. A queue that stands for the whole window becomes the new base because nothing drains it; the pause and the 3 s timeout bound that.
    pub fn base_depth_us(&self) -> u64 {
        self.network_base_depth_us() + self.viewer_wait_us()
    }

    /// Largest capture-to-acknowledgement time over the last 10 s; sizes the frame window.
    pub fn peak_depth_us(&self) -> u64 {
        self.peak.overall(0)
    }

    /// Smallest network depth (capture-to-acknowledgement minus viewer wait) over the last 10 s; zero when unmeasured.
    pub fn network_base_depth_us(&self) -> u64 {
        self.network.overall(0)
    }

    /// Span over which the smallest queueing delay is taken: one base round trip, at least two frame intervals.
    pub fn standing_window_us(&self) -> u64 {
        self.base_depth_us().max(2 * self.frame_interval_us())
    }

    /// Standing queue at which capture stops: the base plus two frame intervals, or 250 ms before any acknowledgement. This mirrors the TCP-statistics rule of twice the round trip plus two frame intervals.
    pub fn pause_queue_us(&self) -> u64 {
        if self.depth.is_empty() {
            Self::PAUSE_AGE_US
        } else {
            self.base_depth_us() + 2 * self.frame_interval_us()
        }
    }

    /// Oldest-frame age at which capture pauses, as /metrics reports it. With TCP statistics it also gates admission; without, it is the base depth plus the pause queue.
    pub fn admission_age_us(&self) -> u64 {
        if self.transport_available {
            self.transport_age_limit_us()
        } else {
            self.base_depth_us() + self.pause_queue_us()
        }
    }

    /// Longest wait a viewer reported for a frame in the last 10 s, up to the 100 ms a viewer may hold one. A longer wait is a viewer falling behind and must not widen the limits.
    pub fn viewer_wait_us(&self) -> u64 {
        Self::VIEWER_HOLD_LIMIT_US.min(self.held.overall(0))
    }

    /// Oldest-frame age at which capture stops with TCP statistics: twice the minimum round trip plus two frame intervals plus the viewer's wait, capped at 3 s, or 250 ms before a round trip is known.
    pub fn transport_age_limit_us(&self) -> u64 {
        if self.transport.min_rtt_us == 0 {
            return Self::PAUSE_AGE_US;
        }
        Self::TIMEOUT_US.min(2 * self.transport.min_rtt_us.min(Self::TIMEOUT_US) + 2 * self.frame_interval_us() + self.viewer_wait_us())
    }

    /// Queueing delay present for the whole recent window: the smallest oldest-frame age or acknowledgement time in it, above the given base.
    fn standing_above(&self, now: u64, acknowledged_depths: &WindowExtreme, base: u64) -> u64 {
        if self.frames.is_empty() {
            return 0;
        }
        let window = self.standing_window_us();
        let lowest = self
            .oldest_age(now)
            .min(acknowledged_depths.over(now, window, u64::MAX, 0))
            .min(self.waiting.over(now, window, u64::MAX, acknowledged_depths.forgotten_us));
        if lowest > base {
            lowest - base
        } else {
            0
        }
    }

    /// The total standing queue, viewer wait included.
    pub fn standing_queue_us(&self, now: u64) -> u64 {
        self.standing_above(now, &self.depth, self.base_depth_us())
    }

    /// The part of the standing queue that is in the network, with the time frames wait inside the viewer taken out.
    pub fn standing_network_queue_us(&self, now: u64) -> u64 {
        self.standing_above(now, &self.network, self.network_base_depth_us())
    }

    /// Classifies a standing queue against the pause limit: clear below a quarter of it, building below half, congested below the limit, paused at it.
    pub fn level_of(&self, queue: u64) -> Pressure {
        let limit = self.pause_queue_us();
        if queue >= limit {
            return Pressure::Paused;
        }
        if queue >= limit / 2 {
            return Pressure::Congested;
        }
        if queue >= limit / 4 {
            Pressure::Building
        } else {
            Pressure::Clear
        }
    }

    /// Bitrate decisions without TCP statistics: the standing network queue against the same limit as the pause.
    pub fn network_pressure(&self, now: u64) -> Pressure {
        self.level_of(self.standing_network_queue_us(now))
    }

    pub fn frame_limit(&self) -> u32 {
        let count = (Self::TIMEOUT_US * u64::from(self.frame_rate) + 999_999) / 1_000_000;
        clamp_u64(count, 2, Self::MAX_FRAMES as u64) as u32
    }

    pub fn notsent_lowat(&self) -> u64 {
        let denominator = u64::from(self.frame_rate) * 4;
        (16 * 1024u64).max((self.target_bitrate + denominator - 1) / denominator)
    }

    pub fn sender_queue_us(&self) -> u64 {
        let mut queued = self.transport.notsent_bytes as f64 + self.transport.application_queued_bytes as f64;
        for frame in self.frames.iter().filter(|f| !f.sent) {
            queued += frame.bytes as f64;
        }
        let rate = if self.delivery_rate_bps != 0 { self.delivery_rate_bps } else { self.target_bitrate.max(1) };
        (queued * 8_000_000.0 / rate as f64).ceil() as u64
    }

    pub fn headroom_bitrate(target: u64, maximum: u64, elapsed_us: u64, queued_us: u64, interval_us: u64, oldest_us: u64, age_limit_us: u64) -> u64 {
        if queued_us >= (interval_us + 1) / 2 || oldest_us >= age_limit_us {
            return target;
        }
        (maximum as f64).min(target as f64 * 1.25f64.powf(elapsed_us as f64 / 1_000_000.0)).round() as u64
    }

    pub fn frame_bitrate(&self) -> u64 {
        if !self.transport_available {
            return self.target_bitrate;
        }
        let interval = self.frame_interval_us();
        let queued = clamp_u64(self.sender_queue_us(), interval, 3 * interval);
        (self.target_bitrate as f64 * (1.0 - 0.75 * (queued - interval) as f64 / (2 * interval) as f64)) as u64
    }

    fn paused_with_transport(&self, now: u64) -> bool {
        self.oldest_age(now) >= self.transport_age_limit_us() || self.frames.len() >= self.window as usize || self.sender_queue_us() >= 3 * self.frame_interval_us()
    }

    fn paused_without_transport(&self, now: u64) -> bool {
        self.level_of(self.standing_queue_us(now)) == Pressure::Paused
    }

    pub fn paused(&self, now: u64) -> bool {
        self.bytes + self.largest_frame > Self::MAX_BYTES || if self.transport_available { self.paused_with_transport(now) } else { self.paused_without_transport(now) }
    }

    pub fn timed_out(&self, now: u64) -> bool {
        !self.frames.is_empty() && (now - now.min(self.last_progress_us) >= Self::TIMEOUT_US || self.oldest_age(now) >= Self::TIMEOUT_US)
    }

    pub fn enqueue(&mut self, seq: u32, size: usize, captured: u64, now: u64) -> bool {
        if seq == 0
            || seq != self.last_encoded.wrapping_add(1)
            || self.frames.len() >= self.frame_limit() as usize
            || size == 0
            || size > Self::MAX_BYTES
            || size > Self::MAX_BYTES - self.bytes
        {
            return false;
        }
        if self.frames.is_empty() {
            self.last_progress_us = now;
        }
        self.frames.push_back(Frame { sequence: seq, bytes: size, captured_us: captured, sent: false, sent_us: 0 });
        self.bytes += size;
        self.largest_frame = self.largest_frame.max(size);
        self.last_encoded = seq;
        self.encoded += 1;
        true
    }

    pub fn sent(&mut self, seq: u32, now: u64) -> bool {
        for frame in self.frames.iter_mut() {
            if frame.sent {
                continue;
            }
            if frame.sequence != seq {
                return false;
            }
            frame.sent = true;
            frame.sent_us = now;
            return true;
        }
        false
    }

    /// Credits the oldest frame. The viewer's wait is untrusted: one longer than the frame's whole capture-to-acknowledgement time counts as zero.
    pub fn ack(&mut self, seq: u32, now: u64, viewer_wait_us: u64) -> bool {
        let frame = match self.frames.front() {
            Some(f) if f.sent && f.sequence == seq => *f,
            _ => return false,
        };
        let rtt = (now - now.min(frame.sent_us)) as f64;
        self.ack_rtt_us = if self.acknowledged != 0 { self.ack_rtt_us * 0.875 + rtt * 0.125 } else { rtt };
        self.record_depth(frame.captured_us, now, viewer_wait_us);
        // Sample continuous demand only: idle gaps and tiny updates are not capacity evidence.
        if !self.transport_available {
            if self.previous_sent_us != 0 && frame.sent_us.wrapping_sub(self.previous_sent_us) > 3 * self.frame_interval_us() {
                self.sample_start_us = 0;
                self.sample_bytes = 0;
                self.sample_acks = 0;
            }
            if self.sample_start_us == 0 {
                self.sample_start_us = frame.sent_us;
            }
            self.previous_sent_us = frame.sent_us;
            self.sample_bytes += frame.bytes as u64;
            self.sample_acks += 1;
        }
        self.bytes -= frame.bytes;
        self.frames.pop_front();
        self.acknowledged += 1;
        self.last_progress_us = now;
        self.update(now);
        true
    }

    fn record_depth(&mut self, captured: u64, now: u64, viewer_wait_us: u64) {
        let total = now - now.min(captured);
        let wait = if viewer_wait_us <= total { viewer_wait_us } else { 0 };
        let kept_before = if self.transport_available { 2 * self.frame_interval_us() } else { self.standing_window_us() };
        self.network.forget(now, kept_before);
        self.depth.push(now, total, Self::BASE_WINDOW_US);
        self.peak.push(now, total, Self::BASE_WINDOW_US);
        self.held.push(now, wait, Self::BASE_WINDOW_US);
        self.network.push(now, total - wait, Self::BASE_WINDOW_US);
        let kept = if self.transport_available { 2 * self.frame_interval_us() } else { self.standing_window_us() };
        self.depth.forget(now, kept);
    }

    fn expire_delivery(&mut self, now: u64) {
        while self.delivery_samples.front().is_some_and(|s| now - now.min(s.time_us) >= Self::DELIVERY_WINDOW_US) {
            self.delivery_samples.pop_front();
        }
        self.delivery_rate_bps = self.delivery_samples.front().map_or(0, |s| s.rate_bps);
    }

    pub fn sample_transport(&mut self, sample: &TransportSample, now: u64) {
        let progress = !self.transport_available || sample.bytes_acked > self.transport.bytes_acked;
        if !self.transport_available {
            self.last_transport_update_us = now;
        }
        self.transport = *sample;
        self.transport_available = true;
        self.expire_delivery(now);
        if progress && !sample.app_limited && sample.delivery_rate_bps != 0 {
            if self.delivery_samples.is_empty() {
                self.last_transport_update_us = now;
            }
            while self.delivery_samples.back().is_some_and(|s| s.rate_bps <= sample.delivery_rate_bps) {
                self.delivery_samples.pop_back();
            }
            self.delivery_samples.push_back(DeliverySample { time_us: now, rate_bps: sample.delivery_rate_bps });
        }
        self.update(now);
    }

    pub fn clear_transport(&mut self) {
        if !self.transport_available {
            return;
        }
        self.transport = TransportSample::default();
        self.transport_available = false;
        self.delivery_rate_bps = 0;
        self.last_transport_update_us = 0;
        self.delivery_samples.clear();
        self.sample_start_us = 0;
        self.sample_bytes = 0;
        self.sample_acks = 0;
        self.previous_sent_us = 0;
        self.goodput_bps = 0.0;
        self.update_window();
    }

    fn window_with_transport(&mut self) {
        let fps = u64::from(self.frame_rate);
        let count = if self.transport.min_rtt_us != 0 {
            ((2 * self.transport.min_rtt_us.min(Self::TIMEOUT_US) + self.viewer_wait_us()) * fps + 999_999) / 1_000_000 + 2
        } else {
            (Self::PAUSE_AGE_US * fps + 999_999) / 1_000_000
        };
        self.window = clamp_u64(count, 2, u64::from(self.frame_limit())) as u32;
    }

    fn window_without_transport(&mut self) {
        self.window = if self.acknowledged != 0 {
            clamp_f64((self.peak_depth_us() as f64 * f64::from(self.frame_rate) / 1_000_000.0).ceil() + 2.0, 2.0, f64::from(self.frame_limit())) as u32
        } else {
            1
        };
    }

    fn update_window(&mut self) {
        if self.transport_available {
            self.window_with_transport()
        } else {
            self.window_without_transport()
        }
    }

    fn bitrate_with_transport(&mut self, now: u64) {
        self.expire_delivery(now);
        let elapsed = now - now.min(self.last_transport_update_us);
        self.last_transport_update_us = now;
        let probe = if self.transport.app_limited || self.delivery_rate_bps == 0 {
            Self::headroom_bitrate(self.target_bitrate, self.max_bitrate, elapsed, self.sender_queue_us(), self.frame_interval_us(), self.oldest_age(now), self.transport_age_limit_us())
        } else {
            0
        };
        if self.delivery_rate_bps != 0 {
            let desired = clamp_f64(self.delivery_rate_bps as f64 * 0.85, self.min_bitrate as f64, self.max_bitrate as f64);
            if !self.transport.app_limited || desired > self.target_bitrate as f64 {
                let weight = 1.0 - (-(elapsed as f64) / Self::BITRATE_SMOOTHING_US as f64).exp();
                let target = self.target_bitrate as f64;
                self.target_bitrate = clamp_u64((target + (desired - target) * weight).round() as u64, self.min_bitrate, self.max_bitrate);
            }
        }
        self.target_bitrate = self.target_bitrate.max(probe);
    }

    fn bitrate_without_transport(&mut self, now: u64) {
        if !self.frames.is_empty() {
            let age = self.oldest_age(now);
            self.waiting.push(now, age, Self::BASE_WINDOW_US);
            let window = self.standing_window_us();
            self.depth.forget(now, window);
            let window = self.standing_window_us();
            self.network.forget(now, window);
        }
        let busy = self.sample_start_us != 0 && self.sample_acks >= 8 && self.sample_bytes >= 65_536;
        let interval = if self.sample_start_us != 0 { now - now.min(self.sample_start_us) } else { 0 };
        if busy && interval >= 500_000 {
            self.goodput_bps = self.sample_bytes as f64 * 8_000_000.0 / interval as f64;
        }
        let state = self.network_pressure(now);
        if self.frames.len() >= 2
            && self.bytes as u64 >= (self.target_bitrate / 80).min(65_536)
            && state >= Pressure::Congested
            && now.wrapping_sub(self.last_decrease_us) >= 500_000
        {
            let mut next = self.target_bitrate * 3 / 4;
            if busy && interval >= 500_000 {
                next = next.min((self.goodput_bps * 0.9) as u64);
            }
            self.target_bitrate = self.min_bitrate.max(next);
            self.last_decrease_us = now;
            self.last_increase_us = now;
        } else if busy
            && interval >= 1_000_000
            && state == Pressure::Clear
            && now.wrapping_sub(self.last_increase_us) >= 1_000_000
            && now.wrapping_sub(self.last_decrease_us) >= 2_000_000
        {
            // CRF can emit far below its cap; prompt ACKs of sustained demand permit a probe.
            self.target_bitrate = self.max_bitrate.min(self.target_bitrate + self.target_bitrate / 10);
            self.last_increase_us = now;
        }
        if interval >= 1_000_000 {
            self.sample_start_us = now;
            self.sample_bytes = 0;
            self.sample_acks = 0;
        }
    }

    pub fn update(&mut self, now: u64) {
        self.update_window();
        if self.transport_available {
            self.bitrate_with_transport(now)
        } else {
            self.bitrate_without_transport(now)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    type F = FlowControl;

    fn configured(min: u64, initial: u64, max: u64, fps: u32) -> F {
        let mut flow = F::default();
        flow.configure(min, initial, max, fps);
        flow
    }

    fn base_sample() -> TransportSample {
        TransportSample { min_rtt_us: 45_000, rtt_us: 50_000, delivery_rate_bps: 10_000_000, bytes_acked: 10_000, snd_cwnd: 20, ..TransportSample::default() }
    }

    /// ACKs arrive after 55ms while capture continues, matching an uncongested 50ms path.
    fn demand(flow: &mut F, count: u32, size: usize, spacing: u64) {
        let mut pending: VecDeque<(u32, u64)> = VecDeque::new();
        for seq in 1..=count {
            let now = u64::from(seq) * spacing;
            while let Some(&(acked, at)) = pending.front() {
                if at > now {
                    break;
                }
                assert!(flow.ack(acked, at, 0));
                pending.pop_front();
            }
            assert!(flow.enqueue(seq, size, now, now) && flow.sent(seq, now));
            pending.push_back((seq, now + 55_000));
        }
        for &(acked, at) in &pending {
            assert!(flow.ack(acked, at, 0));
        }
    }

    #[derive(Default)]
    struct PathRun {
        skipped: u32,
        paused_ticks: u32,
        worst_age: u64,
        min_bitrate: u64,
        bitrate_at_stall: u64,
    }

    #[allow(clippy::too_many_arguments)]
    fn simulate(
        flow: &mut F,
        fps: u32,
        rtt: u64,
        refresh: u64,
        service_gap: u64,
        seconds: u64,
        warmup_us: u64,
        burst: u64,
        stall_at: u64,
        stall_us: u64,
        viewer_wait: u64,
        lifetime_wait: bool,
    ) -> PathRun {
        let mut run = PathRun { min_bitrate: u64::MAX, ..PathRun::default() };
        let mut pending: VecDeque<(u32, u64, u64)> = VecDeque::new();
        let (mut last_ack, mut rng) = (0u64, 12345u64);
        let (mut seq, mut wait_from) = (0u32, u32::MAX);
        let interval = 1_000_000 / u64::from(fps);
        let mut now = 0u64;
        while now < seconds * 1_000_000 {
            while let Some(&(acked, at, captured)) = pending.front() {
                if at > now {
                    break;
                }
                let wait = if lifetime_wait {
                    at - captured
                } else if acked >= wait_from {
                    viewer_wait
                } else {
                    0
                };
                assert!(flow.ack(acked, at, wait));
                pending.pop_front();
            }
            flow.update(now);
            run.worst_age = run.worst_age.max(flow.oldest_age(now));
            if stall_us != 0 && now >= stall_at && run.bitrate_at_stall == 0 {
                run.bitrate_at_stall = flow.target_bitrate;
            }
            if run.bitrate_at_stall != 0 {
                run.min_bitrate = run.min_bitrate.min(flow.target_bitrate);
            }
            let admitted = !flow.paused(now) && flow.frames.len() < flow.window as usize;
            if !admitted {
                if now >= warmup_us {
                    run.skipped += 1;
                    run.paused_ticks += u32::from(flow.paused(now));
                }
                now += interval;
                continue;
            }
            seq += 1;
            assert!(flow.enqueue(seq, (flow.target_bitrate / 8 / u64::from(fps)) as usize, now, now) && flow.sent(seq, now));
            if now >= 2_000_000 && wait_from == u32::MAX {
                wait_from = seq;
            }
            rng = rng.wrapping_mul(6_364_136_223_846_793_005).wrapping_add(1_442_695_040_888_963_407);
            let mut at = now + rtt + if wait_from != u32::MAX { viewer_wait } else { 0 } + (rng >> 33) % (refresh + 1);
            if burst != 0 {
                at = at.div_ceil(burst) * burst;
            }
            if stall_us != 0 && at >= stall_at && at < stall_at + stall_us {
                at = stall_at + stall_us;
            }
            if service_gap != 0 {
                at = at.max(last_ack + service_gap);
            }
            at = at.max(last_ack);
            last_ack = at;
            pending.push_back((seq, at, now));
            now += interval;
        }
        run
    }

    #[test]
    fn credit_follows_the_oldest_sent_frame() {
        let mut f = F::default();
        assert!(f.window == 1 && f.target_bitrate == 8_000_000);
        assert!(!f.ack(1, 1, 0));
        assert!(!f.enqueue(2, 1, 10, 10));
        assert!(!f.enqueue(1, 0, 10, 10));
        assert!(!f.enqueue(1, F::MAX_BYTES + 1, 10, 10));
        assert!(f.enqueue(1, 100, 10, 10));
        assert!(!f.ack(1, 20, 0)); // Encoded but unsent is never credit.
        assert!(f.sent(1, 20));
        assert!(!f.ack(2, 30, 0));
        assert!(f.ack(1, 100_020, 0));
        assert!(f.bytes == 0 && f.acknowledged == 1);
        assert!(!f.ack(1, 100_021, 0));
        for seq in 2..10 {
            assert!(f.enqueue(seq, 100, 100_030, 100_030));
        }
        assert!(f.enqueue(10, 100, 100_030, 100_030));
        assert!(f.sent(2, 100_040));
        assert!(!f.sent(4, 100_040));
        assert!(!f.ack(3, 100_050, 0));
        assert!(f.frames.len() == 9 && f.bytes == 900);
        assert!(!f.paused(100_030 + 100_010 + 100_000) && f.paused(100_030 + 100_010 + 200_000));
        assert!(!f.timed_out(3_100_029) && f.timed_out(3_100_030));
        assert!(f.ack(2, 400_000, 0));
        assert!(!f.timed_out(3_100_029) && f.timed_out(3_100_030)); // Trickle ACKs cannot retain an old tail.
    }

    #[test]
    fn frame_interval_rounds_up() {
        let mut sixty = F::default();
        let mut one_twenty = configured(1_000_000, 8_000_000, 40_000_000, 120);
        assert!(sixty.frame_interval_us() == 16_667 && one_twenty.frame_interval_us() == 8_334);
        assert!(sixty.enqueue(1, 100, 1, 1) && sixty.sent(1, 1) && sixty.ack(1, 45_001, 0));
        assert!(one_twenty.enqueue(1, 100, 1, 1) && one_twenty.sent(1, 1) && one_twenty.ack(1, 45_001, 0));
    }

    #[test]
    fn fallback_frame_limit_is_three_seconds_of_frames() {
        for (fps, limit) in [(10u32, 30u32), (30, 90), (60, 180), (120, 360)] {
            let mut fallback_limit = configured(1_000_000, 8_000_000, 40_000_000, fps);
            assert!(fallback_limit.window == 1);
            assert!(fallback_limit.enqueue(1, 1000, 1, 1) && fallback_limit.sent(1, 1));
            assert!(fallback_limit.ack(1, 1_000_001, 0));
            for seq in 2..=limit + 1 {
                assert!(fallback_limit.enqueue(seq, 1000, 1_000_002, 1_000_002));
            }
            assert!(!fallback_limit.enqueue(limit + 2, 1000, 1_000_002, 1_000_002));
            assert!(fallback_limit.frame_bitrate() == fallback_limit.target_bitrate);
            assert!(fallback_limit.sent(2, 1_000_003) && fallback_limit.ack(2, 1_000_004, 0));
            assert!(fallback_limit.enqueue(limit + 2, 1000, 1_000_005, 1_000_005));
        }
    }

    #[test]
    fn byte_cap_pauses_and_rejects() {
        let mut cap = F::default();
        assert!(cap.enqueue(1, F::MAX_BYTES, 1, 1));
        assert!(cap.paused(1));
        assert!(!cap.enqueue(2, 1, 1, 1));
        assert!(cap.sent(1, 2) && cap.ack(1, 3, 0));
        assert!(cap.bytes == 0 && cap.enqueue(2, 1, 4, 4));
    }

    #[test]
    fn bitrate_without_transport_backs_off_and_probes() {
        let mut congested = F::default();
        assert!(congested.enqueue(1, 100_000, 1, 1));
        assert!(congested.enqueue(2, 100_000, 1, 1));
        congested.update(500_001);
        assert!(congested.target_bitrate == 6_000_000);
        congested.update(500_002);
        assert!(congested.target_bitrate == 6_000_000); // Downshift hysteresis.
        let mut now = 1_000_001;
        while now < 10_000_000 {
            congested.update(now);
            now += 500_000;
        }
        assert!(congested.target_bitrate == 1_000_000);

        let mut small = F::default();
        assert!(small.enqueue(1, 100, 1, 1) && small.enqueue(2, 100, 1, 1));
        small.update(1_000_000);
        assert!(small.target_bitrate == 8_000_000); // Tiny updates are not a bandwidth estimate.

        let mut idle = F::default();
        idle.update(900_000_000);
        assert!(idle.target_bitrate == 8_000_000);
        for seq in 1..=20u32 {
            let now = u64::from(seq) * 1_000_000;
            assert!(idle.enqueue(seq, 200, now, now));
            assert!(idle.sent(seq, now));
            assert!(idle.ack(seq, now + 10_000, 0));
        }
        assert!(idle.target_bitrate == 8_000_000);

        let mut recovery = F::default();
        for seq in 1..=180u32 {
            let now = u64::from(seq) * 16_667;
            assert!(recovery.enqueue(seq, 20_000, now, now));
            assert!(recovery.sent(seq, now));
            assert!(recovery.ack(seq, now + 5000, 0));
        }
        assert!(recovery.target_bitrate > 8_000_000 && recovery.target_bitrate <= 10_648_000);
    }

    #[test]
    fn sustained_demand_probes_and_gaps_do_not() {
        let mut capped_quality = F::default();
        capped_quality.target_bitrate = 8_800_000;
        demand(&mut capped_quality, 180, 18_000, 33_333); // 4.32 Mbit/s is below 60% of the cap.
        assert!(capped_quality.target_bitrate > 8_800_000);

        let mut bounded = F::default();
        demand(&mut bounded, 1800, 18_000, 33_333);
        assert!(bounded.target_bitrate == 40_000_000);
        assert!(bounded.enqueue(1801, 1_000_000, 61_000_000, 61_000_000));
        assert!(bounded.enqueue(1802, 1_000_000, 61_000_000, 61_000_000));
        bounded.update(61_500_000);
        assert!(bounded.target_bitrate < 40_000_000); // Probing cannot disable congestion backoff.

        let mut tiny_continuous = F::default();
        demand(&mut tiny_continuous, 180, 200, 33_333);
        assert!(tiny_continuous.target_bitrate == 8_000_000);
        let mut discontinuous = F::default();
        demand(&mut discontinuous, 60, 100_000, 100_000);
        assert!(discontinuous.target_bitrate == 8_000_000);

        for target in [8_000_000u64, 17_118_698] {
            let mut queued = F::default();
            queued.target_bitrate = target;
            assert!(queued.enqueue(1, 100_000, 1, 1) && queued.sent(1, 1));
            assert!(queued.ack(1, 5001, 0));
            assert!(queued.enqueue(2, 90_000, 5002, 5002));
            assert!(queued.enqueue(3, 90_000, 5002, 5002));
            queued.update(550_002);
            assert!(queued.target_bitrate < target);
        }

        let mut slow = configured(1_000_000, 8_000_000, 40_000_000, 10);
        demand(&mut slow, 100, 18_000, 100_000);
        assert!(slow.target_bitrate > 8_000_000);
    }

    #[test]
    fn service_deadline_follows_activity() {
        let mut timer = F::default();
        let idle_deadline = timer.service_deadline_us(1, 0);
        assert!(idle_deadline == 100_001);
        assert!(timer.enqueue(1, 1000, 2, 2));
        let active_deadline = timer.service_deadline_us(2, idle_deadline);
        assert!(active_deadline == 10_002);
        assert!(timer.service_deadline_us(10_001, active_deadline) == active_deadline);
        let rearmed_deadline = timer.service_deadline_us(active_deadline, 0);
        assert!(rearmed_deadline == 20_002);
        assert!(timer.sent(1, 10_003) && timer.ack(1, 10_004, 0));
        assert!(timer.service_deadline_us(10_005, rearmed_deadline) == rearmed_deadline);
        assert!(timer.service_deadline_us(rearmed_deadline, 0) == 120_002);
    }

    #[test]
    fn transport_capacity_is_three_seconds() {
        let sample = base_sample();
        for fps in [10u32, 30, 60, 120] {
            let mut capacity = configured(1_000_000, 8_000_000, 40_000_000, fps);
            let mut capacity_sample = sample;
            capacity_sample.min_rtt_us = 2_000_000;
            capacity.sample_transport(&capacity_sample, 1);
            let limit = 3 * fps;
            assert!(capacity.frame_limit() == limit && capacity.window == limit);
            assert!(capacity.admission_age_us() == F::TIMEOUT_US);
            for seq in 1..=limit {
                assert!(!capacity.paused(1));
                assert!(capacity.enqueue(seq, 1, 1, 1) && capacity.sent(seq, 1));
            }
            assert!(capacity.paused(1) && !capacity.enqueue(limit + 1, 1, 1, 1));
            assert!(capacity.ack(1, 1_000_001, 0) && capacity.window == limit);
            assert!(!capacity.paused(1_000_001) && capacity.enqueue(limit + 1, 1, 1_000_001, 1_000_001));
            assert!(!capacity.timed_out(3_000_000) && capacity.timed_out(3_000_001));
        }
    }

    #[test]
    fn transport_sender_queue_scales_frame_bitrate() {
        let sample = base_sample();
        for fps in [10u32, 60, 120] {
            let mut budget = configured(4_000_000, 8_000_000, 40_000_000, fps);
            let mut budget_sample = sample;
            budget_sample.delivery_rate_bps = 8_000_000;
            budget.sample_transport(&budget_sample, 1);
            let interval = budget.frame_interval_us();
            assert!(!budget.paused(1) && budget.frame_bitrate() == 8_000_000);
            budget_sample.notsent_bytes = interval - 1;
            budget.sample_transport(&budget_sample, 1);
            assert!(budget.sender_queue_us() == interval - 1);
            assert!(!budget.paused(1) && budget.frame_bitrate() == 8_000_000);
            budget_sample.notsent_bytes = interval;
            budget.sample_transport(&budget_sample, 1);
            assert!(!budget.paused(1) && budget.frame_bitrate() == 8_000_000);
            budget_sample.notsent_bytes = 2 * interval;
            budget.sample_transport(&budget_sample, 1);
            assert!(!budget.paused(1) && budget.frame_bitrate() == 5_000_000);
            assert!(budget.enqueue(1, 1, 1, 1) && budget.sent(1, 1));
            budget_sample.notsent_bytes = 3 * interval - 1;
            budget.sample_transport(&budget_sample, 1);
            assert!(!budget.paused(1) && budget.frame_bitrate() > 2_000_000 && budget.frame_bitrate() < 5_000_000);
            budget_sample.notsent_bytes = 3 * interval;
            budget.sample_transport(&budget_sample, 1);
            assert!(budget.paused(1) && budget.frame_bitrate() == 2_000_000);
            assert!(budget.frame_bitrate() < budget.min_bitrate && budget.target_bitrate == 8_000_000);
            budget_sample.notsent_bytes = 3 * interval + 1;
            budget.sample_transport(&budget_sample, 1);
            assert!(budget.paused(1) && budget.frame_bitrate() == 2_000_000);
            budget_sample.notsent_bytes = 0;
            budget.sample_transport(&budget_sample, 1);
            assert!(!budget.paused(1) && budget.frame_bitrate() == 8_000_000);
        }
    }

    #[test]
    fn delivery_rate_is_the_windowed_maximum() {
        let sample = base_sample();
        let mut estimator = F::default();
        estimator.sample_transport(&sample, 0);
        let mut lower = sample;
        lower.delivery_rate_bps = 6_000_000;
        lower.bytes_acked += 10_000;
        estimator.sample_transport(&lower, 500_000);
        assert!(estimator.delivery_rate_bps == 10_000_000);
        lower.bytes_acked += 10_000;
        estimator.sample_transport(&lower, 999_999);
        assert!(estimator.delivery_rate_bps == 10_000_000);
        estimator.update(1_000_000);
        assert!(estimator.delivery_rate_bps == 6_000_000);
        lower.delivery_rate_bps = 20_000_000;
        estimator.sample_transport(&lower, 1_200_000);
        assert!(estimator.delivery_rate_bps == 6_000_000);
        estimator.sample_transport(&lower, 1_999_999);
        assert!(estimator.delivery_rate_bps == 0);
    }

    #[test]
    fn app_limited_samples_never_lower_the_target() {
        let sample = base_sample();
        let mut limited = F::default();
        let mut app_limited = sample;
        app_limited.app_limited = true;
        app_limited.delivery_rate_bps = 1_000_000;
        limited.sample_transport(&app_limited, 1);
        app_limited.bytes_acked += 10_000;
        limited.sample_transport(&app_limited, 500_001);
        assert!(limited.delivery_rate_bps == 0 && limited.target_bitrate > 8_000_000);
        let mut eligible = sample;
        eligible.delivery_rate_bps = 6_000_000;
        eligible.bytes_acked = 30_000;
        limited.sample_transport(&eligible, 500_002);
        let limited_target = limited.target_bitrate;
        app_limited.delivery_rate_bps = 100_000_000;
        app_limited.bytes_acked = 40_000;
        limited.sample_transport(&app_limited, 750_002);
        limited.update(800_002);
        assert!(limited.delivery_rate_bps == 6_000_000 && limited.target_bitrate >= limited_target);
        let cached_target = limited.target_bitrate;
        app_limited.bytes_acked += 10_000;
        limited.sample_transport(&app_limited, 1_500_002);
        assert!(limited.delivery_rate_bps == 0 && limited.target_bitrate >= cached_target);
    }

    #[test]
    fn headroom_probe_grows_only_while_the_queue_is_empty() {
        let sample = base_sample();
        for app_limited_sample in [true, false] {
            let mut probing = F::default();
            let mut sparse_probing = F::default();
            let mut headroom = sample;
            headroom.app_limited = app_limited_sample;
            headroom.delivery_rate_bps = if app_limited_sample { 1_000_000 } else { 0 };
            probing.sample_transport(&headroom, 1);
            sparse_probing.sample_transport(&headroom, 1);
            let mut elapsed = 100_000u64;
            while elapsed <= 8_000_000 {
                let previous = probing.target_bitrate;
                headroom.bytes_acked += 10_000;
                probing.sample_transport(&headroom, elapsed + 1);
                probing.update(elapsed + 1);
                assert!(probing.target_bitrate >= previous && probing.target_bitrate <= probing.max_bitrate);
                if elapsed % 500_000 == 0 {
                    sparse_probing.sample_transport(&headroom, elapsed + 1);
                    assert!((probing.target_bitrate as f64 - sparse_probing.target_bitrate as f64).abs() < 100.0);
                }
                if elapsed == 1_000_000 {
                    assert!((probing.target_bitrate as f64 - 10_000_000.0).abs() < 100.0);
                }
                elapsed += 100_000;
            }
            assert!(probing.target_bitrate == probing.max_bitrate);

            for queued_us in [probing.frame_interval_us().div_ceil(2), probing.frame_interval_us() + 1] {
                let mut building = F::default();
                headroom.notsent_bytes = queued_us;
                building.sample_transport(&headroom, 1);
                assert!(building.sender_queue_us() == queued_us);
                building.update(1_000_001);
                assert!(building.target_bitrate == 8_000_000);
            }

            let mut stale = F::default();
            headroom.notsent_bytes = 0;
            stale.sample_transport(&headroom, 1);
            assert!(stale.enqueue(1, 1000, 1, 1) && stale.sent(1, 1));
            assert!(stale.sender_queue_us() == 0);
            stale.update(1 + stale.admission_age_us());
            stale.update(1_000_001);
            assert!(stale.target_bitrate == 8_000_000);
        }
    }

    #[test]
    fn target_smooths_toward_delivery_within_limits() {
        let sample = base_sample();
        let mut smoothed = F::default();
        let mut frequent = F::default();
        let mut fast = sample;
        fast.delivery_rate_bps = 20_000_000;
        smoothed.sample_transport(&fast, 0);
        frequent.sample_transport(&fast, 0);
        assert!(smoothed.target_bitrate == 8_000_000);
        smoothed.update(500_000);
        let mut now = 10_000;
        while now <= 500_000 {
            frequent.update(now);
            now += 10_000;
        }
        assert!(smoothed.target_bitrate > 13_600_000 && smoothed.target_bitrate < 13_800_000);
        assert!((smoothed.target_bitrate as f64 - frequent.target_bitrate as f64).abs() < 100.0);
        assert!(smoothed.notsent_lowat() > 56_000 && smoothed.notsent_lowat() < 58_000);

        let low_budget = configured(1_000_000, 1_000_000, 40_000_000, 60);
        assert!(low_budget.notsent_lowat() == 16_384);

        let mut clamped = configured(4_000_000, 8_000_000, 12_000_000, 60);
        fast.delivery_rate_bps = 100_000_000;
        clamped.sample_transport(&fast, 0);
        let mut now = 500_000;
        while now <= 10_000_000 {
            fast.bytes_acked += 10_000;
            clamped.sample_transport(&fast, now);
            assert!(clamped.target_bitrate >= 8_000_000 && clamped.target_bitrate <= 12_000_000);
            now += 500_000;
        }
        assert!(clamped.target_bitrate >= 11_999_000);
        fast.delivery_rate_bps = 1_000_000;
        let mut now = 10_500_000;
        while now <= 22_000_000 {
            fast.bytes_acked += 10_000;
            clamped.sample_transport(&fast, now);
            assert!(clamped.target_bitrate >= 4_000_000 && clamped.target_bitrate <= 12_000_000);
            now += 500_000;
        }
        assert!(clamped.target_bitrate <= 4_001_000 && clamped.notsent_lowat() == 16_667);
    }

    #[test]
    fn sender_queue_counts_unsent_frames_and_kernel_bytes() {
        let sample = base_sample();
        let mut queued = F::default();
        queued.sample_transport(&sample, 1);
        assert!(queued.enqueue(1, 20_000, 1, 1));
        assert!(queued.sender_queue_us() == 16_000 && !queued.paused(1));
        assert!(queued.enqueue(2, 1000, 1, 1));
        assert!(queued.sender_queue_us() == 16_800 && !queued.paused(1));
        assert!(queued.frame_bitrate() < queued.target_bitrate);
        assert!(queued.sent(1, 2));
        assert!(queued.sender_queue_us() == 800 && !queued.paused(2));
        let mut buffered = sample;
        buffered.notsent_bytes = 10_000;
        buffered.application_queued_bytes = 10_000;
        queued.sample_transport(&buffered, 3);
        assert!(queued.sender_queue_us() == 16_800 && !queued.paused(3));
        assert!(queued.frame_bitrate() < queued.target_bitrate);
        assert!(queued.sent(2, 4));
        assert!(queued.sender_queue_us() == 16_000 && !queued.paused(4));
        queued.sample_transport(&sample, 5);
        assert!(queued.bytes == 21_000 && queued.sender_queue_us() == 0 && !queued.paused(5));

        let mut startup = F::default();
        let mut zero_rate = sample;
        zero_rate.delivery_rate_bps = 0;
        startup.sample_transport(&zero_rate, 1);
        assert!(startup.enqueue(1, 17_000, 1, 1));
        assert!(startup.target_bitrate == 8_000_000 && startup.delivery_rate_bps == 0);
        assert!(startup.sender_queue_us() == 17_000 && !startup.paused(1));
        assert!(startup.frame_bitrate() < startup.target_bitrate);
        assert!(startup.sent(1, 2));
        assert!(startup.sender_queue_us() == 0 && !startup.paused(2));
    }

    #[test]
    fn transport_window_follows_the_minimum_round_trip() {
        let sample = base_sample();
        let mut lossy = F::default();
        let mut high_rtt = sample;
        high_rtt.min_rtt_us = 200_000;
        high_rtt.rtt_us = 600_000;
        high_rtt.total_retrans = 12;
        lossy.sample_transport(&high_rtt, 1);
        let lossy_window = lossy.window;
        for seq in 1..=12 {
            assert!(lossy.enqueue(seq, 100_000, 1, 1) && lossy.sent(seq, 1));
        }
        lossy.update(300_001);
        assert!(lossy.window > 8 && lossy.window == lossy_window && !lossy.paused(300_001));
        assert!(lossy.target_bitrate >= 8_000_000);
        high_rtt.total_retrans += 10;
        high_rtt.rtt_us = 1_000_000;
        lossy.sample_transport(&high_rtt, 300_002);
        assert!(lossy.window == lossy_window && lossy.target_bitrate >= 8_000_000);
        assert!(lossy.ack(1, 300_003, 0));
        assert!(lossy.ack_rtt_us > 300_000.0 && lossy.window == lossy_window && !lossy.paused(300_003));
        assert!(!lossy.paused(1 + lossy.admission_age_us() - 1));
        assert!(lossy.paused(1 + lossy.admission_age_us()));

        let mut low_fps = configured(1_000_000, 8_000_000, 40_000_000, 10);
        low_fps.sample_transport(&high_rtt, 1);
        assert!(low_fps.admission_age_us() == 600_000 && low_fps.window == 6);
        assert!(lossy.admission_age_us() == 433_334 && lossy.window == 26);
        let mut high_fps = configured(1_000_000, 8_000_000, 40_000_000, 120);
        high_fps.sample_transport(&sample, 1);
        assert!(high_fps.admission_age_us() == 106_668 && high_fps.window == 13);
        assert!(high_fps.notsent_lowat() == 16_667);
        assert!(high_fps.enqueue(1, 1, 1, 1) && high_fps.sent(1, 1));
        assert!(high_fps.ack(1, 500_001, 0) && high_fps.window == 13);
        high_fps.clear_transport();
        assert!(high_fps.frame_bitrate() == high_fps.target_bitrate);
        let mut distant = sample;
        distant.min_rtt_us = 2_000_000;
        low_fps.sample_transport(&distant, 2);
        assert!(low_fps.admission_age_us() == F::TIMEOUT_US && low_fps.window == 30);
        for seq in 1..=30 {
            assert!(low_fps.enqueue(seq, 1, 2, 2));
        }
        assert!(!low_fps.enqueue(31, 1, 2, 2) && low_fps.paused(2));
    }

    #[test]
    fn clearing_transport_falls_back() {
        let sample = base_sample();
        let mut fallback = configured(1_000_000, 8_000_000, 40_000_000, 10);
        fallback.sample_transport(&sample, 1);
        assert!(fallback.enqueue(1, 100_000, 1, 1) && fallback.sent(1, 1));
        assert!(fallback.ack(1, 100_001, 0));
        let fallback_target = fallback.target_bitrate;
        fallback.clear_transport();
        assert!(!fallback.transport_available && fallback.delivery_rate_bps == 0);
        assert!(fallback.frame_bitrate() == fallback.target_bitrate);
        assert!(fallback.enqueue(2, 100_000, 100_002, 100_002));
        assert!(fallback.enqueue(3, 100_000, 100_002, 100_002));
        assert!(!fallback.paused(500_001) && fallback.paused(500_002));
        fallback.update(600_002);
        assert!(fallback.target_bitrate < fallback_target && fallback.target_bitrate >= fallback.min_bitrate);
        fallback.clear_transport();
        assert!(fallback.frames.len() == 2 && fallback.target_bitrate < fallback_target);
    }

    #[test]
    fn byte_cap_with_transport_and_its_timeout() {
        let sample = base_sample();
        let mut kernel_cap = F::default();
        kernel_cap.sample_transport(&sample, 1);
        assert!(kernel_cap.enqueue(1, F::MAX_BYTES, 1, 1));
        assert!(kernel_cap.paused(1) && !kernel_cap.enqueue(2, 1, 1, 1));
        assert!(kernel_cap.sent(1, 2) && kernel_cap.ack(1, 3, 0));
        assert!(kernel_cap.enqueue(2, 1, 4, 4) && kernel_cap.sent(2, 4));
        kernel_cap.sample_transport(&sample, 3_000_003);
        assert!(!kernel_cap.timed_out(3_000_003) && kernel_cap.timed_out(3_000_004));
    }

    #[test]
    fn reset_keeps_the_configured_limits() {
        let sample = base_sample();
        let mut session = configured(2_000_000, 9_000_000, 30_000_000, 10);
        session.sample_transport(&sample, 1);
        assert!(session.enqueue(1, 1000, 1, 1) && session.sent(1, 2));
        session.reset();
        assert!(!session.transport_available && session.delivery_rate_bps == 0);
        assert!(session.transport.min_rtt_us == 0 && session.transport.bytes_acked == 0);
        assert!(session.frames.is_empty() && session.bytes == 0 && session.window == 1);
        assert!(session.frame_rate == 10 && session.target_bitrate == 9_000_000);
        assert!(session.min_bitrate == 2_000_000 && session.max_bitrate == 30_000_000);
        assert!(!session.timed_out(9_000_000) && session.enqueue(1, 1000, 9_000_001, 9_000_001));
    }

    #[test]
    fn clean_paths_never_skip() {
        for fps in [60u32, 120] {
            for rtt in [100_000u64, 150_000, 300_000] {
                let mut clean = configured(1_000_000, 8_000_000, 40_000_000, fps);
                let run = simulate(&mut clean, fps, rtt, 16_667, 0, 12, 2_000_000, 0, 0, 0, 0, false);
                assert!(run.skipped == 0);
                assert!(clean.target_bitrate > 16_000_000);
            }
        }
    }

    #[test]
    fn bursty_acks_never_pause() {
        for fps in [60u32, 120] {
            let mut bursty = configured(1_000_000, 8_000_000, 40_000_000, fps);
            let interval = 1_000_000 / u64::from(fps);
            let run = simulate(&mut bursty, fps, 100_000, 0, 0, 20, 2_000_000, 5 * interval, 0, 0, 0, false);
            assert!(run.worst_age >= 100_000 + 3 * interval);
            assert!(run.skipped == 0 && run.paused_ticks == 0);
            assert!(bursty.target_bitrate > 16_000_000);
        }
    }

    #[test]
    fn a_short_hiccup_keeps_the_bitrate() {
        for fps in [60u32, 120] {
            let mut hiccup = configured(1_000_000, 8_000_000, 40_000_000, fps);
            let run = simulate(&mut hiccup, fps, 100_000, 16_667, 0, 30, 0, 0, 10_000_000, 300_000, 0, false);
            assert!(run.min_bitrate > 4_000_000);
            assert!(hiccup.target_bitrate >= run.bitrate_at_stall);
        }
    }

    #[test]
    fn a_viewer_wait_is_not_queue() {
        for fps in [60u32, 120] {
            let mut waiting = configured(1_000_000, 8_000_000, 40_000_000, fps);
            let run = simulate(&mut waiting, fps, 100_000, 0, 0, 9, 2_000_000, 0, 0, 0, 80_000, false);
            assert!(run.paused_ticks == 0 && run.skipped <= fps / 10);
            assert!(waiting.target_bitrate > 12_000_000);
        }

        for fps in [60u32, 120] {
            let mut short_hold = configured(1_000_000, 8_000_000, 40_000_000, fps);
            assert!(simulate(&mut short_hold, fps, 20_000, 0, 0, 12, 2_000_000, 0, 0, 0, 80_000, false).skipped <= fps / 10);
        }
    }

    #[test]
    fn lan_jitter_never_pauses() {
        for fps in [60u32, 120] {
            for base in [5000u64, 20_000] {
                let interval = 1_000_000 / u64::from(fps);
                for jitter in [interval, 2 * interval] {
                    let mut lan = configured(1_000_000, 8_000_000, 40_000_000, fps);
                    let run = simulate(&mut lan, fps, base, jitter, 0, 12, 2_000_000, 0, 0, 0, 0, false);
                    assert!(run.skipped == 0 && run.paused_ticks == 0);
                    assert!(lan.target_bitrate >= 8_000_000);
                }
            }
        }
    }

    #[test]
    fn a_long_stall_pauses_and_recovers() {
        for fps in [60u32, 120] {
            let mut stalled = configured(1_000_000, 8_000_000, 40_000_000, fps);
            let run = simulate(&mut stalled, fps, 100_000, 16_667, 0, 15, 0, 0, 5_000_000, 1_500_000, 0, false);
            assert!(run.paused_ticks > 0 && run.worst_age >= 1_500_000 && run.worst_age < F::TIMEOUT_US);
            assert!(!stalled.paused(15_000_000) && stalled.acknowledged > 10 * u64::from(fps));
        }
    }

    #[test]
    fn a_slow_service_bounds_the_queue() {
        let mut hidden = F::default();
        let hidden_run = simulate(&mut hidden, 60, 100_000, 16_667, 40_000, 20, 0, 0, 0, 0, 0, true);
        assert!(hidden_run.paused_ticks > 0);
        assert!(hidden_run.worst_age < 900_000);

        let mut growing = F::default();
        let grown = simulate(&mut growing, 60, 100_000, 16_667, 40_000, 20, 0, 0, 0, 0, 0, false);
        assert!(grown.paused_ticks > 0 && growing.target_bitrate < 8_000_000);
        assert!(grown.worst_age < 850_000);
    }

    #[test]
    fn byte_budget_pauses_before_a_frame_cannot_fit() {
        let mut budget = F::default();
        for seq in 1..=4 {
            assert!(!budget.paused(1) && budget.enqueue(seq, 1536 * 1024, 1, 1));
        }
        assert!(!budget.paused(1) && budget.enqueue(5, 1536 * 1024, 1, 1) && budget.paused(1));
    }

    #[test]
    fn viewer_wait_is_untrusted_and_read_from_four_bytes() {
        let mut untrusted = F::default();
        assert!(untrusted.enqueue(1, 100, 1, 1) && untrusted.sent(1, 1));
        assert!(untrusted.ack(1, 100_001, 4_294_967_295));
        assert!(untrusted.network_base_depth_us() == 100_000 && untrusted.base_depth_us() == 100_000);
        assert!(untrusted.enqueue(2, 100, 100_002, 100_002) && untrusted.sent(2, 100_002));
        assert!(untrusted.ack(2, 200_002, 100_000));
        assert!(untrusted.network_base_depth_us() == 0 && untrusted.base_depth_us() == 100_000);
        let four = [0u8, 0, 0x27, 0x10];
        assert!(F::ack_wait_us(&four) == 10_000 && F::ack_wait_us(&four[..0]) == 0 && F::ack_wait_us(&four[..3]) == 0);
        let huge = [0xffu8, 0xff, 0xff, 0xff];
        assert!(F::ack_wait_us(&huge) == 4_294_967_295);
    }

    #[test]
    fn a_direct_link_with_a_viewer_hold_never_blocks() {
        for fps in [60u32, 120] {
            let mut direct = configured(1_000_000, 8_000_000, 40_000_000, fps);
            let mut link = TransportSample { min_rtt_us: 2000, rtt_us: 2000, delivery_rate_bps: 40_000_000, snd_cwnd: 20, ..TransportSample::default() };
            let (interval, hold) = (direct.frame_interval_us(), 60_000u64);
            let mut blocked = 0u64;
            let (mut captured, mut acked) = (0u32, 0u32);
            let mut shown_at: VecDeque<u64> = VecDeque::new();
            for tick in 0..3_000_000u64 / 1000 {
                let now = 1 + tick * 1000;
                link.bytes_acked += 5000;
                direct.sample_transport(&link, now);
                while shown_at.front().is_some_and(|&at| at <= now) {
                    acked += 1;
                    assert!(direct.ack(acked, now, hold));
                    shown_at.pop_front();
                }
                if now >= u64::from(captured) * interval + 1 {
                    if direct.paused(now) || shown_at.len() >= direct.window as usize {
                        if now > 1_000_000 {
                            blocked += 1;
                        }
                        continue;
                    }
                    captured += 1;
                    assert!(direct.enqueue(captured, 5000, now, now) && direct.sent(captured, now));
                    shown_at.push_back(now + 2000 + hold);
                }
            }
            assert!(blocked == 0 && captured >= 3 * fps - 2);
        }
    }
}
