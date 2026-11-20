//! The bytes pipe's records (docs/computer-protocol.md §30): the stream's
//! number as four bytes, big-endian, then one whole NSL1 message, a 20-byte
//! big-endian header (magic, version, type, flags, generation, sequence,
//! payload length) and its payload. The service writes frames and reads acks.
//! `src/shared/video/nsl1.ts` and `src/shared/computer/videoPipe.ts` are the
//! same bytes on the host's side; the Mac's are `VideoWire.swift`.

use crate::generated::contract::video;

pub const MAGIC: u32 = 0x4e53_4c31;
pub const VERSION: u8 = 1;
pub const HEADER_SIZE: usize = 20;
/// width, height and the capture time, ahead of a frame's access unit
pub const FRAME_PREFIX: usize = 12;
pub const MAX_ACCESS_UNIT: usize = 8 * 1024 * 1024;
/// the largest whole message: the header, a frame's prefix and an access unit of 8 MiB
pub const MAX_MESSAGE: usize = HEADER_SIZE + FRAME_PREFIX + MAX_ACCESS_UNIT;
pub const ID_BYTES: usize = video::PIPE_ID_BYTES as usize;

pub const FRAME_TYPE: u8 = 1;
pub const ACK_TYPE: u8 = 2;
pub const KEYFRAME_FLAG: u16 = 1;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WireError(pub String);

impl std::fmt::Display for WireError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

/// One encoded picture, as a frame message carries it.
#[derive(Debug, Clone, PartialEq)]
pub struct Frame<'a> {
    pub generation: u32,
    pub sequence: u32,
    pub keyframe: bool,
    pub width: u32,
    pub height: u32,
    /// when the capture took the picture, in microseconds on the service's monotonic clock
    pub capture_us: u64,
    /// one H.264 access unit in Annex B form
    pub access_unit: &'a [u8],
}

/// One record read off the pipe: the stream's number and one message's header and payload.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Record {
    pub stream: u32,
    pub kind: u8,
    pub flags: u16,
    pub generation: u32,
    pub sequence: u32,
    pub payload: Vec<u8>,
}

impl Record {
    /// An ack's viewer wait in microseconds: four bytes, else 0 (screen-relay's `ackWaitUs`).
    pub fn ack_wait_us(&self) -> u64 {
        match self.payload[..] {
            [a, b, c, d] => u32::from_be_bytes([a, b, c, d]) as u64,
            _ => 0,
        }
    }
}

fn header(out: &mut Vec<u8>, kind: u8, flags: u16, generation: u32, sequence: u32, length: usize) {
    out.extend_from_slice(&MAGIC.to_be_bytes());
    out.push(VERSION);
    out.push(kind);
    out.extend_from_slice(&flags.to_be_bytes());
    out.extend_from_slice(&generation.to_be_bytes());
    out.extend_from_slice(&sequence.to_be_bytes());
    out.extend_from_slice(&(length as u32).to_be_bytes());
}

/// The record for one frame of `stream`, whole: what the service writes.
pub fn frame_record(stream: u32, f: &Frame) -> Result<Vec<u8>, WireError> {
    let bad = |why: &str| Err(WireError(why.into()));
    if stream == 0 {
        return bad("invalid stream number");
    }
    if f.generation == 0 {
        return bad("invalid generation");
    }
    if f.sequence == 0 {
        return bad("invalid frame sequence");
    }
    if !(1..=0xffff).contains(&f.width) || !(1..=0xffff).contains(&f.height) {
        return bad("invalid picture size");
    }
    if f.access_unit.is_empty() || f.access_unit.len() > MAX_ACCESS_UNIT {
        return bad("invalid access unit");
    }
    let mut out = Vec::with_capacity(ID_BYTES + HEADER_SIZE + FRAME_PREFIX + f.access_unit.len());
    out.extend_from_slice(&stream.to_be_bytes());
    header(&mut out, FRAME_TYPE, if f.keyframe { KEYFRAME_FLAG } else { 0 }, f.generation, f.sequence, FRAME_PREFIX + f.access_unit.len());
    out.extend_from_slice(&(f.width as u16).to_be_bytes());
    out.extend_from_slice(&(f.height as u16).to_be_bytes());
    out.extend_from_slice(&f.capture_us.to_be_bytes());
    out.extend_from_slice(f.access_unit);
    Ok(out)
}

/// The record for one ack, with the viewer's wait when given: what the host writes (the tests and fakes).
pub fn ack_record(stream: u32, generation: u32, sequence: u32, wait_us: Option<u32>) -> Vec<u8> {
    let mut out = Vec::with_capacity(ID_BYTES + HEADER_SIZE + 4);
    out.extend_from_slice(&stream.to_be_bytes());
    header(&mut out, ACK_TYPE, 0, generation, sequence, if wait_us.is_some() { 4 } else { 0 });
    if let Some(w) = wait_us {
        out.extend_from_slice(&w.to_be_bytes());
    }
    out
}

/// Cuts the pipe's bytes into records as they come, in whatever pieces. A record whose stream number is 0, that
/// has no NSL1 magic after its number, or that names a message past the wire's limit is an error: the pipe has
/// lost its place and cannot find it again.
#[derive(Debug, Default)]
pub struct RecordReader {
    buf: Vec<u8>,
    start: usize,
}

impl RecordReader {
    pub fn push(&mut self, chunk: &[u8]) -> Result<Vec<Record>, WireError> {
        self.buf.extend_from_slice(chunk);
        let mut out = Vec::new();
        let read32 = |b: &[u8], at: usize| u32::from_be_bytes([b[at], b[at + 1], b[at + 2], b[at + 3]]);
        while self.buf.len() - self.start >= ID_BYTES + HEADER_SIZE {
            let s = self.start;
            let stream = read32(&self.buf, s);
            if stream == 0 || read32(&self.buf, s + ID_BYTES) != MAGIC {
                return Err(WireError("the bytes pipe lost its place".into()));
            }
            let length = HEADER_SIZE + read32(&self.buf, s + ID_BYTES + 16) as usize;
            if length > MAX_MESSAGE {
                return Err(WireError("a message on the bytes pipe is larger than the wire allows".into()));
            }
            if self.buf.len() - s < ID_BYTES + length {
                break;
            }
            let m = s + ID_BYTES;
            out.push(Record {
                stream,
                kind: self.buf[m + 5],
                flags: u16::from_be_bytes([self.buf[m + 6], self.buf[m + 7]]),
                generation: read32(&self.buf, m + 8),
                sequence: read32(&self.buf, m + 12),
                payload: self.buf[m + HEADER_SIZE..m + length].to_vec(),
            });
            self.start += ID_BYTES + length;
        }
        if self.start == self.buf.len() {
            self.buf.clear();
            self.start = 0;
        } else if self.start > 64 * 1024 {
            self.buf.drain(..self.start);
            self.start = 0;
        }
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const UNIT: [u8; 6] = [0, 0, 0, 1, 0x65, 0xaa];

    fn frame(generation: u32, sequence: u32, keyframe: bool) -> Frame<'static> {
        Frame { generation, sequence, keyframe, width: 640, height: 400, capture_us: 0x0102_0304_0506_0708, access_unit: &UNIT }
    }

    #[test]
    fn a_frame_record_is_the_stream_then_the_header_then_the_payload() {
        let bytes = frame_record(7, &frame(1, 2, true)).unwrap();
        #[rustfmt::skip]
        let want: Vec<u8> = vec![
            0, 0, 0, 7,             // stream
            0x4e, 0x53, 0x4c, 0x31, // NSL1
            1, 1, 0, 1,             // version, frame, keyframe
            0, 0, 0, 1,             // generation
            0, 0, 0, 2,             // sequence
            0, 0, 0, 18,            // payload: 12 + 6
            0x02, 0x80, 0x01, 0x90, // 640 × 400
            1, 2, 3, 4, 5, 6, 7, 8, // capture time
            0, 0, 0, 1, 0x65, 0xaa,
        ];
        assert_eq!(bytes, want);
        assert_eq!(&frame_record(7, &frame(1, 2, false)).unwrap()[10..12], &[0, 0]);
    }

    #[test]
    fn a_frame_outside_the_wire_is_refused() {
        let good = Frame { width: 2, height: 2, ..frame(1, 1, true) };
        assert!(frame_record(1, &good).is_ok());
        assert!(frame_record(0, &good).is_err());
        assert!(frame_record(1, &Frame { generation: 0, ..good.clone() }).is_err());
        assert!(frame_record(1, &Frame { sequence: 0, ..good.clone() }).is_err());
        assert!(frame_record(1, &Frame { width: 0, ..good.clone() }).is_err());
        assert!(frame_record(1, &Frame { height: 70_000, ..good.clone() }).is_err());
        assert!(frame_record(1, &Frame { access_unit: &[], ..good.clone() }).is_err());
    }

    #[test]
    fn an_ack_is_the_bare_header_or_four_bytes_of_wait() {
        assert_eq!(ack_record(3, 2, 9, None), vec![0, 0, 0, 3, 0x4e, 0x53, 0x4c, 0x31, 1, 2, 0, 0, 0, 0, 0, 2, 0, 0, 0, 9, 0, 0, 0, 0]);
        let waited = ack_record(3, 2, 9, Some(10_000));
        assert_eq!(&waited[waited.len() - 8..], &[0, 0, 0, 4, 0, 0, 0x27, 0x10]);
    }

    #[test]
    fn the_reader_takes_records_in_odd_pieces() {
        let f = Frame { generation: 4, sequence: 5, keyframe: false, width: 8, height: 6, capture_us: 99, access_unit: &UNIT };
        let mut bytes = frame_record(2, &f).unwrap();
        bytes.extend(ack_record(9, 1, 1, Some(300)));
        bytes.extend(ack_record(9, 1, 2, None));
        let mut reader = RecordReader::default();
        let mut records = Vec::new();
        let mut at = 0;
        for size in [1, 3, 2, 17, 5, 1, 40, 7, 1000] {
            if at >= bytes.len() {
                break;
            }
            let end = bytes.len().min(at + size);
            records.extend(reader.push(&bytes[at..end]).unwrap());
            at = end;
        }
        assert_eq!(at, bytes.len());
        assert_eq!(records.len(), 3);
        assert_eq!(records[0], Record { stream: 2, kind: 1, flags: 0, generation: 4, sequence: 5, payload: bytes[24..24 + 18].to_vec() });
        assert_eq!((records[1].stream, records[1].kind, records[1].sequence, records[1].ack_wait_us()), (9, ACK_TYPE, 1, 300));
        assert_eq!((records[2].sequence, records[2].ack_wait_us()), (2, 0));
        assert!(reader.push(&[]).unwrap().is_empty());
    }

    #[test]
    fn a_record_with_no_magic_or_stream_or_past_the_limit_loses_the_place() {
        assert!(RecordReader::default().push(&[0x58; 32]).is_err());

        let mut no_stream = ack_record(1, 1, 1, None);
        no_stream[3] = 0;
        assert!(RecordReader::default().push(&no_stream).is_err());

        let over = (FRAME_PREFIX + MAX_ACCESS_UNIT + 1) as u32;
        let mut long = ack_record(1, 1, 1, None);
        long[20..24].copy_from_slice(&over.to_be_bytes());
        assert!(RecordReader::default().push(&long).is_err());

        // the limit itself is a whole record still to come, not an error
        let mut largest = ack_record(1, 1, 1, None);
        largest[20..24].copy_from_slice(&(over - 1).to_be_bytes());
        assert!(RecordReader::default().push(&largest).unwrap().is_empty());
    }
}
