//! H.264 access units as the wire carries them (docs/computer-protocol.md §30):
//! Annex B, a start code ahead of each NAL unit, and a keyframe's SPS and PPS
//! ahead of it. Media Foundation's encoders write Annex B, but whether a later
//! IDR repeats its parameter sets is the encoder's choice, and a hardware one
//! may write lengths (AVCC) in place of start codes; `Normalizer` makes every
//! unit the wire's whatever came. Pure.

pub const NAL_SLICE: u8 = 1;
pub const NAL_IDR: u8 = 5;
pub const NAL_SPS: u8 = 7;
pub const NAL_PPS: u8 = 8;

const START: [u8; 4] = [0, 0, 0, 1];

/// Whether the bytes begin with a start code.
pub fn is_annex_b(bytes: &[u8]) -> bool {
    bytes.starts_with(&[0, 0, 1]) || bytes.starts_with(&[0, 0, 0, 1])
}

/// The NAL units of an Annex B stream, without their start codes.
pub fn nal_units(bytes: &[u8]) -> Vec<&[u8]> {
    let mut starts = Vec::new(); // (where the code begins, where the unit begins)
    let mut i = 0;
    while i + 3 <= bytes.len() {
        if bytes[i] == 0 && bytes[i + 1] == 0 && bytes[i + 2] == 1 {
            let code = if i > 0 && bytes[i - 1] == 0 { i - 1 } else { i };
            starts.push((code, i + 3));
            i += 3;
        } else {
            i += 1;
        }
    }
    let mut out = Vec::with_capacity(starts.len());
    for (k, &(_, from)) in starts.iter().enumerate() {
        let to = starts.get(k + 1).map_or(bytes.len(), |n| n.0);
        // trailing zero bytes belong to no unit
        let mut end = to;
        while end > from && bytes[end - 1] == 0 && k + 1 == starts.len() {
            end -= 1;
        }
        if end > from {
            out.push(&bytes[from..end]);
        }
    }
    out
}

pub fn nal_type(unit: &[u8]) -> u8 {
    unit.first().map_or(0, |b| b & 0x1f)
}

/// Length-prefixed units (AVCC, `len` bytes big-endian each) as Annex B; None when the lengths do not add up.
pub fn avcc_to_annex_b(bytes: &[u8], len: usize) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(bytes.len() + 16);
    let mut at = 0;
    while at < bytes.len() {
        if at + len > bytes.len() {
            return None;
        }
        let n = bytes[at..at + len].iter().fold(0usize, |n, b| n << 8 | *b as usize);
        at += len;
        if n == 0 || at + n > bytes.len() {
            return None;
        }
        out.extend_from_slice(&START);
        out.extend_from_slice(&bytes[at..at + n]);
        at += n;
    }
    (!out.is_empty()).then_some(out)
}

/// Makes each access unit the wire's: Annex B, and a keyframe led by the SPS and PPS the encoder last gave.
#[derive(Debug, Default, Clone)]
pub struct Normalizer {
    sps: Option<Vec<u8>>,
    pps: Option<Vec<u8>>,
}

impl Normalizer {
    /// Learns the parameter sets of a sequence header (the output type's `MF_MT_MPEG_SEQUENCE_HEADER`), Annex B or AVCC.
    pub fn learn(&mut self, header: &[u8]) {
        let annex = if is_annex_b(header) { Some(header.to_vec()) } else { avcc_to_annex_b(header, 4) };
        if let Some(annex) = annex {
            self.take_sets(&nal_units(&annex));
        }
    }

    fn take_sets(&mut self, units: &[&[u8]]) {
        for u in units {
            match nal_type(u) {
                NAL_SPS => self.sps = Some(u.to_vec()),
                NAL_PPS => self.pps = Some(u.to_vec()),
                _ => {}
            }
        }
    }

    /// The unit in Annex B, and whether it is a keyframe (it holds an IDR slice). A keyframe that lacks its SPS or
    /// PPS gets the last ones seen ahead of its first unit; None when the bytes are no H.264 this can read.
    pub fn unit(&mut self, raw: &[u8]) -> Option<(Vec<u8>, bool)> {
        let annex = if is_annex_b(raw) { raw.to_vec() } else { avcc_to_annex_b(raw, 4)? };
        let units = nal_units(&annex);
        if units.is_empty() {
            return None;
        }
        self.take_sets(&units);
        let key = units.iter().any(|u| nal_type(u) == NAL_IDR);
        let has = |t: u8| units.iter().any(|u| nal_type(u) == t);
        if !key || (has(NAL_SPS) && has(NAL_PPS)) {
            return Some((annex, key));
        }
        let (Some(sps), Some(pps)) = (&self.sps, &self.pps) else { return Some((annex, key)) };
        let mut out = Vec::with_capacity(annex.len() + sps.len() + pps.len() + 8);
        for u in units {
            // the sets go ahead of the first slice or SEI, after an access unit delimiter
            if nal_type(u) != 9 && !out.windows(sps.len()).any(|w| w == &sps[..]) {
                out.extend_from_slice(&START);
                out.extend_from_slice(sps);
                out.extend_from_slice(&START);
                out.extend_from_slice(pps);
            }
            if matches!(nal_type(u), NAL_SPS | NAL_PPS) {
                continue;
            }
            out.extend_from_slice(&START);
            out.extend_from_slice(u);
        }
        Some((out, key))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SPS: [u8; 5] = [0x67, 0x64, 0x00, 0x1f, 0xac];
    const PPS: [u8; 3] = [0x68, 0xee, 0x3c];
    const IDR: [u8; 3] = [0x65, 0x88, 0x84];
    const SLICE: [u8; 3] = [0x41, 0x9a, 0x02];
    const SEI: [u8; 2] = [0x06, 0x05];

    fn annex(units: &[&[u8]]) -> Vec<u8> {
        units.iter().flat_map(|u| START.iter().chain(u.iter()).copied()).collect()
    }

    #[test]
    fn units_are_found_after_three_and_four_byte_start_codes() {
        let mut bytes = vec![0, 0, 1];
        bytes.extend(SPS);
        bytes.extend([0, 0, 0, 1]);
        bytes.extend(IDR);
        bytes.extend([0, 0]); // trailing zeros are no part of the slice
        assert_eq!(nal_units(&bytes), vec![&SPS[..], &IDR[..]]);
        assert!(is_annex_b(&bytes) && !is_annex_b(&IDR));
        assert!(nal_units(&IDR).is_empty());
    }

    #[test]
    fn lengths_become_start_codes() {
        let avcc = [&[0, 0, 0, 3][..], &IDR, &[0, 0, 0, 3], &SLICE].concat();
        assert_eq!(avcc_to_annex_b(&avcc, 4).unwrap(), annex(&[&IDR, &SLICE]));
        assert_eq!(avcc_to_annex_b(&[0, 0, 0, 9, 1, 2], 4), None, "a length past the end");
        assert_eq!(avcc_to_annex_b(&[], 4), None);
    }

    #[test]
    fn a_keyframe_with_its_sets_passes_as_it_came() {
        let mut n = Normalizer::default();
        let au = annex(&[&SPS, &PPS, &IDR]);
        assert_eq!(n.unit(&au), Some((au.clone(), true)));
        let p = annex(&[&SLICE]);
        assert_eq!(n.unit(&p), Some((p.clone(), false)));
    }

    #[test]
    fn a_keyframe_without_its_sets_gets_the_last_ones_ahead_of_its_first_unit() {
        let mut n = Normalizer::default();
        // from the output type's sequence header, in either form
        n.learn(&[&[0, 0, 0, 5][..], &SPS, &[0, 0, 0, 3], &PPS].concat());
        assert_eq!(n.unit(&annex(&[&SEI, &IDR])).unwrap(), (annex(&[&SPS, &PPS, &SEI, &IDR]), true));
        // an access unit delimiter stays first
        let aud: [u8; 2] = [0x09, 0xf0];
        assert_eq!(n.unit(&annex(&[&aud, &IDR])).unwrap().0, annex(&[&aud, &SPS, &PPS, &IDR]));
        // a set seen in a unit is the one used next
        let sps2: [u8; 5] = [0x67, 0x64, 0x00, 0x28, 0xac];
        n.unit(&annex(&[&sps2, &PPS, &IDR]));
        assert_eq!(n.unit(&annex(&[&IDR])).unwrap().0, annex(&[&sps2, &PPS, &IDR]));
        // a keyframe in lengths comes out in start codes
        let avcc = [&[0, 0, 0, 3][..], &IDR].concat();
        assert_eq!(n.unit(&avcc).unwrap(), (annex(&[&sps2, &PPS, &IDR]), true));
        assert_eq!(n.unit(&[1, 2, 3]), None);
    }

    #[test]
    fn with_no_sets_known_a_bare_keyframe_passes_as_it_came() {
        let mut n = Normalizer::default();
        assert_eq!(n.unit(&annex(&[&IDR])), Some((annex(&[&IDR]), true)));
    }
}
