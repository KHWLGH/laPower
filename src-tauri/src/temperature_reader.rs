// SPDX-FileCopyrightText: 2026 KHWLGH
// SPDX-License-Identifier: GPL-3.0-only
// For original project contributions; see COPYRIGHT.
//! Bounded TCP line parsing. A rejected line stays rejected until its newline.

use std::io::{self, Read};
use std::sync::atomic::{AtomicBool, Ordering};

struct Lines {
    bytes: [u8; 256],
    length: usize,
    discarding: bool,
}

impl Default for Lines {
    fn default() -> Self {
        Self {
            bytes: [0; 256],
            length: 0,
            discarding: false,
        }
    }
}

impl Lines {
    fn finish(&mut self, emit: &mut impl FnMut(f32)) -> io::Result<()> {
        if !self.discarding {
            let line = std::str::from_utf8(&self.bytes[..self.length])
                .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
            if let Ok(value) = line.trim().parse::<f32>() {
                if value.is_finite() {
                    emit(value);
                }
            }
        }
        self.length = 0;
        self.discarding = false;
        Ok(())
    }

    fn feed(&mut self, chunk: &[u8], emit: &mut impl FnMut(f32)) -> io::Result<()> {
        for &byte in chunk {
            if !self.discarding {
                if self.length == 256 {
                    self.length = 0;
                    self.discarding = true;
                } else {
                    self.bytes[self.length] = byte;
                    self.length += 1;
                }
            }
            if byte == b'\n' {
                self.finish(emit)?;
            }
        }
        Ok(())
    }
}

pub fn receive(
    mut reader: impl Read,
    running: &AtomicBool,
    mut emit: impl FnMut(f32),
) -> io::Result<()> {
    let mut lines = Lines::default();
    let mut chunk = [0; 1024];
    while running.load(Ordering::Relaxed) {
        match reader.read(&mut chunk) {
            Ok(0) => {
                lines.finish(&mut emit)?;
                return Ok(());
            }
            Ok(count) => lines.feed(&chunk[..count], &mut emit)?,
            Err(error)
                if matches!(
                    error.kind(),
                    io::ErrorKind::TimedOut
                        | io::ErrorKind::WouldBlock
                        | io::ErrorKind::Interrupted
                ) => {}
            Err(error) => return Err(error),
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn oversized_lines_remain_bounded_and_recover_only_after_newline() {
        let mut lines = Lines::default();
        let mut values = Vec::new();
        for _ in 0..16384 {
            lines
                .feed(&[b'1'; 1024], &mut |value| values.push(value))
                .unwrap();
            assert!(lines.length <= 256);
        }
        lines
            .feed(b"23\n24.5\r\nNaN\n", &mut |value| values.push(value))
            .unwrap();
        assert_eq!(values, [24.5]);
    }

    #[test]
    fn limit_counts_crlf_and_invalid_utf8_keeps_read_error_semantics() {
        let mut lines = Lines::default();
        let mut values = Vec::new();
        lines
            .feed(&[b' '; 253], &mut |value| values.push(value))
            .unwrap();
        lines
            .feed(b"1\r\n", &mut |value| values.push(value))
            .unwrap();
        lines
            .feed(&[b' '; 254], &mut |value| values.push(value))
            .unwrap();
        lines
            .feed(b"9\r\n2\n", &mut |value| values.push(value))
            .unwrap();
        assert_eq!(values, [1.0, 2.0]);
        assert_eq!(
            receive(&b"\xff\n"[..], &AtomicBool::new(true), |_| {})
                .unwrap_err()
                .kind(),
            io::ErrorKind::InvalidData
        );
    }

    #[test]
    fn partial_line_survives_timeouts_and_eof() {
        struct Source(usize);
        impl Read for Source {
            fn read(&mut self, out: &mut [u8]) -> io::Result<usize> {
                self.0 += 1;
                let bytes: &[u8] = match self.0 {
                    1 => b"2",
                    2 => return Err(io::ErrorKind::TimedOut.into()),
                    3 => return Err(io::ErrorKind::WouldBlock.into()),
                    4 => b"5.5\r\n26",
                    _ => b"",
                };
                out[..bytes.len()].copy_from_slice(bytes);
                Ok(bytes.len())
            }
        }
        let mut values = Vec::new();
        receive(Source(0), &AtomicBool::new(true), |value| {
            values.push(value)
        })
        .unwrap();
        assert_eq!(values, [25.5, 26.0]);
    }

    #[test]
    fn continuous_input_checks_stop_between_bounded_reads() {
        let running = AtomicBool::new(true);
        struct Source<'a>(&'a AtomicBool, usize);
        impl Read for Source<'_> {
            fn read(&mut self, out: &mut [u8]) -> io::Result<usize> {
                self.1 += 1;
                assert!(self.1 <= 32);
                if self.1 == 32 {
                    self.0.store(false, Ordering::Relaxed);
                }
                out.fill(b'1');
                Ok(out.len())
            }
        }
        receive(Source(&running, 0), &running, |_| {
            panic!("unterminated line")
        })
        .unwrap();
    }
}
