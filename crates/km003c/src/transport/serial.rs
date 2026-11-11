// SPDX-FileCopyrightText: 2026 KHWLGH
// SPDX-License-Identifier: LGPL-3.0-or-later
// For original project contributions; see COPYRIGHT.
//! CDC 虚拟串口：充电器协议触发文本命令。

use std::io::{Read, Write};
use std::time::{Duration, Instant};

use anyhow::{anyhow, Context, Result};
use serialport::{SerialPort, SerialPortType};

use super::{is_powerz_pid, model_name, VID};
use crate::StopSignal;

const BAUD: u32 = 115_200;
const READ_SLICE: Duration = Duration::from_millis(40);
const IDLE_DEFAULT: Duration = Duration::from_millis(1200);
const IDLE_ENTRY: Duration = Duration::from_secs(3);
const IDLE_PD: Duration = Duration::from_secs(3);
const IDLE_LIST: Duration = Duration::from_secs(25);
const IDLE_LIST_PLUS: Duration = Duration::from_secs(90);
const MAX_REPLY_BYTES: usize = 256 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CmdClass {
    ListPlus,
    List,
    Entry,
    Pd,
    Other,
}

#[derive(Debug, Clone)]
pub struct SerialDeviceInfo {
    pub port_name: String,
    pub vid: u16,
    pub pid: u16,
    pub manufacturer: Option<String>,
    pub product: Option<String>,
    pub serial: Option<String>,
}

pub fn list_ports() -> Result<Vec<SerialDeviceInfo>> {
    let mut ports = Vec::new();
    for port in serialport::available_ports().context("failed to list serial ports")? {
        if let SerialPortType::UsbPort(usb) = port.port_type {
            if usb.vid == VID && is_powerz_pid(usb.pid) {
                ports.push(SerialDeviceInfo {
                    port_name: port.port_name,
                    vid: usb.vid,
                    pid: usb.pid,
                    manufacturer: usb.manufacturer,
                    product: usb.product,
                    serial: usb.serial_number,
                });
            }
        }
    }
    Ok(ports)
}

pub fn open(port: Option<&str>) -> Result<CdcPort> {
    open_matching(port, None)
}

/// Open the CDC port, preferring a POWER-Z COM whose USB serial matches `serial`.
pub fn open_matching(port: Option<&str>, serial: Option<&str>) -> Result<CdcPort> {
    let name = match port {
        Some(p) => p.to_string(),
        None => {
            let ports = list_ports()?;
            let sn = serial.map(str::trim).filter(|s| !s.is_empty() && *s != "-");
            let chosen = if let Some(sn) = sn {
                ports
                    .iter()
                    .find(|p| p.serial.as_deref() == Some(sn))
                    .ok_or_else(|| anyhow!("未找到序列号 {sn} 的 POWER-Z 串口"))?
            } else {
                ports.first().ok_or_else(|| {
                    anyhow!(
                        "未找到 POWER-Z 虚拟串口。Windows 10/11 通常免驱；Win7 需安装官方 CDC 驱动。"
                    )
                })?
            };
            chosen.port_name.clone()
        }
    };
    CdcPort::open(&name)
}

pub struct CdcPort {
    port: Box<dyn SerialPort>,
    pub name: String,
    pub model: &'static str,
    stop: Option<StopSignal>,
}

impl CdcPort {
    pub fn open(name: &str) -> Result<Self> {
        let mut port = serialport::new(name, BAUD)
            .timeout(READ_SLICE)
            .open()
            .with_context(|| format!("无法打开串口 {name}"))?;
        let _ = port.write_data_terminal_ready(true);
        let _ = port.write_request_to_send(true);
        let _ = port.flush();
        std::thread::sleep(Duration::from_millis(50));
        let _ = port.clear(serialport::ClearBuffer::All);

        let pid = list_ports()
            .ok()
            .and_then(|ports| {
                ports
                    .into_iter()
                    .find(|p| p.port_name == name)
                    .map(|p| p.pid)
            })
            .unwrap_or(super::PID_KM003C);

        Ok(Self {
            port,
            name: name.to_string(),
            model: model_name(pid),
            stop: None,
        })
    }

    /// Abort replies in progress once `stop` is set, within one read slice.
    pub fn set_stop(&mut self, stop: StopSignal) {
        self.stop = Some(stop);
    }

    pub fn send_command(&mut self, command: &str, wait: Duration) -> Result<String> {
        self.send_command_stream(command, wait, |_| {})
    }

    /// Send a command and invoke `on_line` for each complete payload line as it arrives.
    pub fn send_command_stream(
        &mut self,
        command: &str,
        wait: Duration,
        on_line: impl FnMut(&str),
    ) -> Result<String> {
        self.send_command_stream_raw(command, wait, on_line)
            .map(|(text, _)| text)
    }

    /// Like [`send_command_stream`], but also returns the raw CDC byte buffer so
    /// callers can decode binary tails (e.g. `pd pdo` → `pdo:N` + u32 LE objects).
    pub fn send_command_stream_raw(
        &mut self,
        command: &str,
        wait: Duration,
        mut on_line: impl FnMut(&str),
    ) -> Result<(String, Vec<u8>)> {
        anyhow::ensure!(
            !self.stop.as_ref().is_some_and(StopSignal::is_set),
            "已取消"
        );
        let _ = self.port.clear(serialport::ClearBuffer::Input);
        let payload = if command.ends_with('\n') {
            command.to_string()
        } else {
            format!("{command}\r\n")
        };
        self.port
            .write_all(payload.as_bytes())
            .with_context(|| format!("write to {} failed", self.name))?;
        self.port.flush().ok();
        self.read_until_stream(wait, suggested_idle(command), command, &mut on_line)
    }

    fn read_until_stream(
        &mut self,
        overall: Duration,
        idle: Duration,
        command: &str,
        on_line: &mut dyn FnMut(&str),
    ) -> Result<(String, Vec<u8>)> {
        read_reply(
            self.port.as_mut(),
            self.stop.as_ref(),
            overall,
            idle,
            command,
            on_line,
        )
    }
}

fn read_reply(
    port: &mut (impl Read + ?Sized),
    stop: Option<&StopSignal>,
    overall: Duration,
    idle: Duration,
    command: &str,
    on_line: &mut dyn FnMut(&str),
) -> Result<(String, Vec<u8>)> {
    let start = Instant::now();
    let mut buf = Vec::new();
    let mut tmp = [0u8; 256];
    let mut last_payload = Instant::now();
    let mut saw_payload = false;
    let mut lines = ReplyLines::default();

    let result = (|| -> Result<()> {
        while start.elapsed() < overall {
            anyhow::ensure!(!stop.is_some_and(StopSignal::is_set), "已取消");
            match port.read(&mut tmp) {
                Ok(0) => {}
                Ok(n) => {
                    anyhow::ensure!(
                        buf.len() + n <= MAX_REPLY_BYTES,
                        "串口响应超过 256 KiB 上限"
                    );
                    buf.extend_from_slice(&tmp[..n]);
                    lines.push(&buf, command, on_line);
                    if lines.has_payload(&buf, command) {
                        last_payload = Instant::now();
                        saw_payload = true;
                    }
                    // Only a complete scan terminator ends reading immediately. Entry
                    // replies can print status/capabilities after ready; drain their idle window.
                    if is_scan_command(command) && response_complete(command, &lines.text) {
                        break;
                    }
                }
                Err(e) if e.kind() == std::io::ErrorKind::TimedOut => {}
                Err(e) => {
                    // PDM close may drop CDC after its ACK; keep that complete ACK,
                    // but never promote a partial/progress reply to success.
                    lines.finish(&buf, command, on_line);
                    if saw_payload
                        && (is_scan_command(command) || control_reply_confirmed(&lines.text))
                    {
                        break;
                    }
                    return Err(e).context("serial read failed");
                }
            }
            // Echo-only must not start the idle clock. Handshake is often silent
            // until ready/fail; list gaps between protocols are much longer.
            if saw_payload && last_payload.elapsed() >= idle {
                break;
            }
        }
        Ok(())
    })();
    // Cancellation, buffer limits and transport failures must retain the last
    // received line too. Finishing advances the cursor, so it cannot emit twice.
    lines.finish(&buf, command, on_line);
    result?;
    Ok((lines.text.trim().to_string(), buf))
}

/// Decode only complete byte lines: later binary/GBK data must not change the
/// encoding of text already emitted. Raw bytes remain untouched for PDO parsing.
#[derive(Default)]
struct ReplyLines {
    start: usize,
    scanned: usize,
    skip_lf: bool,
    saw_first: bool,
    text: String,
}

impl ReplyLines {
    fn push(&mut self, buf: &[u8], command: &str, on_line: &mut dyn FnMut(&str)) {
        for i in self.scanned..buf.len() {
            let byte = buf[i];
            if self.skip_lf && byte == b'\n' {
                self.start = i + 1;
                self.skip_lf = false;
                continue;
            }
            self.skip_lf = byte == b'\r';
            if matches!(byte, b'\r' | b'\n') {
                self.emit(&buf[self.start..i], command, on_line);
                self.start = i + 1;
            }
        }
        self.scanned = buf.len();
    }

    fn emit(&mut self, raw: &[u8], command: &str, on_line: &mut dyn FnMut(&str)) {
        let decoded = decode_serial_text(raw);
        if decoded.trim().is_empty() {
            return;
        }
        let line = if self.saw_first {
            decoded.trim().to_string()
        } else {
            self.saw_first = true;
            strip_command_echo(&decoded, command)
        };
        if !line.is_empty() {
            self.text.push_str(&line);
            self.text.push('\n');
            on_line(&line);
        }
    }

    fn has_payload(&self, buf: &[u8], command: &str) -> bool {
        let tail = String::from_utf8_lossy(&buf[self.start..]);
        !self.text.is_empty()
            || (!tail.trim().is_empty()
                && (self.saw_first
                    || !command
                        .trim()
                        .to_ascii_lowercase()
                        .starts_with(&tail.trim().to_ascii_lowercase())))
    }

    fn finish(&mut self, buf: &[u8], command: &str, on_line: &mut dyn FnMut(&str)) {
        self.emit(&buf[self.start..], command, on_line);
        self.start = buf.len();
        self.scanned = buf.len();
    }
}

fn classify_command(cmd: &str) -> CmdClass {
    let c = cmd.trim().to_ascii_lowercase();
    if c.contains("list+") || c.contains("vooc") || c.contains("mtk") {
        CmdClass::ListPlus
    } else if c.contains("list") {
        CmdClass::List
    } else if c.starts_with("entry") {
        CmdClass::Entry
    } else if is_pd_view_command(&c) {
        CmdClass::Pd
    } else {
        CmdClass::Other
    }
}

fn is_pd_view_command(c: &str) -> bool {
    let c = c.trim();
    c.starts_with("pd pdo")
        || c.starts_with("pd cmd")
        || c.starts_with("pd req")
        || c.starts_with("pd data")
        || c.starts_with("ufcs pdo")
}

/// Inter-line silence before treating a reply as finished.
pub fn suggested_idle(cmd: &str) -> Duration {
    match classify_command(cmd) {
        CmdClass::ListPlus => IDLE_LIST_PLUS,
        CmdClass::List => IDLE_LIST,
        CmdClass::Entry => IDLE_ENTRY,
        CmdClass::Pd => IDLE_PD,
        CmdClass::Other => IDLE_DEFAULT,
    }
}

/// Wait long enough for protocol-scan / entry commands to finish printing.
pub fn suggested_wait(cmd: &str) -> Duration {
    match classify_command(cmd) {
        CmdClass::ListPlus => Duration::from_secs(180),
        CmdClass::List => Duration::from_secs(90),
        CmdClass::Entry | CmdClass::Pd => Duration::from_secs(12),
        CmdClass::Other => Duration::from_secs(6),
    }
}

pub fn entry_failed(text: &str) -> bool {
    text.lines().any(|line| {
        let t = line.trim().to_ascii_lowercase();
        !t.is_empty() && !is_protocol_scan_line(&t) && line_looks_failed(&t)
    })
}

/// A control response has no scan-result rows to ignore: `PD: FAIL` is failure.
pub fn command_failed(text: &str) -> bool {
    text.lines()
        .any(|line| line_looks_failed(&line.trim().to_ascii_lowercase()))
}

fn is_scan_command(command: &str) -> bool {
    matches!(
        classify_command(command),
        CmdClass::List | CmdClass::ListPlus
    )
}

fn control_reply_confirmed(text: &str) -> bool {
    !command_failed(text)
        && text.lines().any(|line| {
            matches!(
                line.trim().to_ascii_lowercase().as_str(),
                "ok" | "success" | "request accepted"
            )
        })
}

fn is_protocol_scan_line(lower: &str) -> bool {
    let Some((name, rest)) = lower.split_once(':') else {
        return false;
    };
    let name = name.trim();
    let rest = rest.trim();
    if name.is_empty() || name == "fail" || name == "error" {
        return false;
    }
    rest == "ok"
        || rest == "fail"
        || rest == "n/a"
        || rest == "na"
        || rest == "no"
        || rest.starts_with("fail")
}

fn line_looks_failed(lower: &str) -> bool {
    lower.contains("fail")
        || lower.contains("error")
        || lower.contains("失败")
        || lower.contains("not support")
        || lower.contains("unsupported")
        || lower.contains("not supported")
        || lower.contains("reject")
        || lower.contains("denied")
        || lower.contains("invalid")
        || lower.contains("timeout")
        || lower.contains("timed out")
        || lower.contains("not ready")
        || lower.contains("busy")
        || lower.contains("不支持")
        || lower.contains("拒绝")
        || lower.contains("超时")
        || lower.contains("未就绪")
}

pub fn entry_ready(text: &str) -> bool {
    let t = text.to_ascii_lowercase();
    t.contains("ready") || t.contains("就绪")
}

pub fn reply_confirmed(text: &str) -> bool {
    !command_failed(text) && (entry_ready(text) || control_reply_confirmed(text))
}

fn entry_terminal(text: &str) -> bool {
    entry_ready(text) || command_failed(text)
}

fn response_complete(cmd: &str, text: &str) -> bool {
    if is_scan_command(cmd) {
        // A protocol's ready/FAIL belongs to one entry; only `done` ends a scan.
        // A firmware-level rejection of list+ is terminal too, so old firmware can
        // fall back immediately instead of waiting through the long list idle gap.
        text.lines()
            .any(|line| line.trim().eq_ignore_ascii_case("done"))
            || (cmd.trim().eq_ignore_ascii_case("entry list+") && list_command_rejected(text))
    } else {
        matches!(classify_command(cmd), CmdClass::Entry) && entry_terminal(text)
    }
}

fn list_command_rejected(text: &str) -> bool {
    text.lines().any(|line| {
        let line = line.trim().to_ascii_lowercase();
        [
            "invalid command",
            "unknown command",
            "unsupported command",
            "command not supported",
            "command is not supported",
            "命令无效",
            "未知命令",
            "不支持的命令",
        ]
        .iter()
        .any(|phrase| line.contains(phrase))
    })
}

fn replacement_count(s: &str) -> usize {
    s.chars().filter(|&c| c == '\u{FFFD}').count()
}

fn decode_serial_text(buf: &[u8]) -> String {
    let text = match std::str::from_utf8(buf) {
        Ok(s) => s.to_string(),
        Err(err) => {
            let utf8 = String::from_utf8_lossy(buf);
            // Streaming reads often split a UTF-8 character across chunks.
            if err.error_len().is_none() {
                utf8.into_owned()
            } else {
                let (gbk, _, _) = encoding_rs::GB18030.decode(buf);
                if replacement_count(&gbk) < replacement_count(&utf8) {
                    gbk.into_owned()
                } else {
                    utf8.into_owned()
                }
            }
        }
    };
    text.replace("\r\n", "\n").replace('\r', "\n")
}

fn strip_command_echo(text: &str, command: &str) -> String {
    let cmd = command.trim().trim_end_matches(['\r', '\n']).trim();
    let mut lines: Vec<&str> = text.lines().collect();
    while matches!(lines.first(), Some(l) if l.trim().is_empty()) {
        lines.remove(0);
    }
    if let Some(first) = lines.first() {
        if first.trim().eq_ignore_ascii_case(cmd) {
            lines.remove(0);
        }
    }
    lines.join("\n").trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;

    fn gbk_bytes(s: &str) -> Vec<u8> {
        encoding_rs::GB18030.encode(s).0.into_owned()
    }

    #[test]
    fn decode_keeps_utf8_when_truncated_multibyte() {
        // "就绪" is E5 B0 B1 E7 BB AA; drop the last byte so UTF-8 is incomplete.
        let mut buf = "就绪".as_bytes().to_vec();
        buf.pop();
        let text = decode_serial_text(&buf);
        assert!(text.starts_with("就"), "{text:?}");
        assert!(!text.contains("�") || text.chars().filter(|&c| c == '�').count() <= 1);
    }

    #[test]
    fn decode_gbk_chinese_words() {
        assert_eq!(decode_serial_text(&gbk_bytes("失败")), "失败");
        assert_eq!(decode_serial_text(&gbk_bytes("就绪")), "就绪");
        assert_eq!(decode_serial_text(&gbk_bytes("不支持")), "不支持");
    }

    #[test]
    fn decode_ascii_mixed_with_gbk_pdo_reply() {
        let mut buf = b"PDO 1: 5.00V 3.00A ".to_vec();
        buf.extend_from_slice(&gbk_bytes("固定"));
        buf.extend_from_slice(b"\nPDO 2: 9.00V 2.00A ");
        buf.extend_from_slice(&gbk_bytes("失败"));
        let text = decode_serial_text(&buf);
        assert!(text.contains("固定"), "{text:?}");
        assert!(text.contains("失败"), "{text:?}");
        assert!(!text.contains('\u{FFFD}'), "{text:?}");
    }

    #[test]
    fn decode_cr_is_newline() {
        assert_eq!(
            decode_serial_text(b"svooc:\rPD3.2:60W PDO:7\n"),
            "svooc:\nPD3.2:60W PDO:7\n"
        );
        assert_eq!(decode_serial_text(b"a\r\nb\n"), "a\nb\n");
        assert!(!decode_serial_text(b"svooc:\rPD3.2").contains("svooc:PD"));
    }

    #[test]
    fn suggested_wait_for_entry_list_is_long() {
        assert_eq!(suggested_wait("entry list"), Duration::from_secs(90));
        assert_eq!(suggested_wait("entry list+"), Duration::from_secs(180));
        assert_eq!(suggested_wait("entry pd"), Duration::from_secs(12));
        assert_eq!(suggested_wait("pd pdo"), Duration::from_secs(12));
        assert_eq!(suggested_wait("pd cmd=7"), Duration::from_secs(12));
        assert_eq!(suggested_wait("pd req=2,cur=3000"), Duration::from_secs(12));
        assert_eq!(
            suggested_wait("pd data=018F1401A000FF"),
            Duration::from_secs(12)
        );
        assert_eq!(suggested_wait("ufcs pdo"), Duration::from_secs(12));
        assert_eq!(suggested_wait("qc 9V"), Duration::from_secs(6));
    }

    #[test]
    fn suggested_idle_spans_protocol_scan_gaps() {
        assert_eq!(suggested_idle("entry list"), Duration::from_secs(25));
        assert_eq!(suggested_idle("entry list+"), Duration::from_secs(90));
        assert_eq!(suggested_idle("entry pd"), Duration::from_secs(3));
        assert_eq!(suggested_idle("pd pdo"), Duration::from_secs(3));
        assert_eq!(suggested_idle("qc 9V"), Duration::from_millis(1200));
    }

    #[test]
    fn list_does_not_complete_on_first_ready() {
        assert!(!response_complete("entry list", "PD ready"));
        assert!(!response_complete("entry list+", "PD ready\nQC: FAIL"));
        assert!(!response_complete("entry list", "invalid command"));
        assert!(response_complete("entry list+", "invalid command"));
        assert!(response_complete("entry list+", "unknown command: list+"));
        assert!(response_complete("entry list+", "PD ready\nQC: FAIL\ndone"));
        assert!(response_complete("entry pd", "PD\nready"));
        assert!(response_complete("entry qc", "fail: not support"));
    }

    #[test]
    fn command_echo_is_not_payload() {
        assert!(strip_command_echo("entry list\n", "entry list")
            .trim()
            .is_empty());
        assert!(strip_command_echo("entry qc\r\n", "entry qc")
            .trim()
            .is_empty());
        assert_eq!(
            strip_command_echo("entry pd\nready", "entry pd").trim(),
            "ready"
        );
    }

    #[test]
    fn entry_failed_detects_keywords() {
        assert!(entry_failed("FAIL not support"));
        assert!(entry_failed("进入失败"));
        assert!(entry_failed("fail: not support"));
        assert!(!entry_failed("ready"));
        assert!(!entry_failed("PD : OK\nFCP : FAIL\nAFC : n/a"));
        assert!(entry_ready("PD\nready"));
    }

    #[test]
    fn response_buffer_is_bounded_and_cancellation_interrupts_reading() {
        let result = read_reply(
            &mut std::io::repeat(b'x'),
            None,
            Duration::from_secs(10),
            IDLE_PD,
            "pd req=3",
            &mut |_| {},
        );
        assert!(result.unwrap_err().to_string().contains("256 KiB"));
        let stop = StopSignal::new(
            std::sync::Arc::new(std::sync::atomic::AtomicBool::new(true)),
            std::sync::Arc::new(std::sync::atomic::AtomicBool::new(true)),
        );
        let result = read_reply(
            &mut std::io::repeat(b'x'),
            Some(&stop),
            Duration::from_secs(10),
            IDLE_PD,
            "pd req=3",
            &mut |_| {},
        );
        assert_eq!(result.unwrap_err().to_string(), "已取消");
    }

    #[test]
    fn cdc_drop_preserves_scans_but_rejects_partial_control_replies() {
        struct DropAfter(std::io::Cursor<Vec<u8>>);
        impl Read for DropAfter {
            fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
                match self.0.read(buf)? {
                    0 => Err(std::io::ErrorKind::BrokenPipe.into()),
                    n => Ok(n),
                }
            }
        }
        for (command, reply, ok) in [
            (
                "entry list",
                "PD : OK\nQC2.0 : OK\nFCP : FAIL\nUFCS : OK",
                true,
            ),
            ("entry list+", "PPS : OK\n", true),
            ("entry list", "entry list\n", false),
            ("pd req=3,volt=21000,cur=3000", "request pending\n", false),
            ("pdm open", "opening\n", false),
            ("pdm close", "closing\n", false),
            ("pdm close", "ok\n", true),
            ("pdm close", "ok\nrequest rejected\n", false),
            ("pd req=3,volt=21000,cur=3000", "request accepted\n", true),
            ("entry pd", "negotiating\n", false),
        ] {
            let mut port = DropAfter(std::io::Cursor::new(reply.as_bytes().to_vec()));
            let result = read_reply(
                &mut port,
                None,
                Duration::from_secs(1),
                suggested_idle(command),
                command,
                &mut |_| {},
            );
            assert_eq!(result.is_ok(), ok, "{command}: {result:?}");
            if ok {
                assert_eq!(result.unwrap().0, reply.trim());
            }
        }
    }

    #[test]
    fn complete_lines_survive_split_echo_crlf_and_multibyte_encodings() {
        let mut out = Vec::new();
        let mut lines = ReplyLines::default();
        let mut raw = b"\r\npd pdo\r\n".to_vec();
        raw.extend_from_slice("就绪\r\nready:5100mV,0mA\r".as_bytes());
        raw.extend_from_slice(b"\n");
        raw.extend_from_slice(&gbk_bytes("最大功率 100W"));
        raw.extend_from_slice(b"\nno trailing newline");
        for end in 1..=raw.len() {
            lines.push(&raw[..end], "pd pdo", &mut |line| {
                out.push(line.to_string())
            });
        }
        assert_eq!(out, ["就绪", "ready:5100mV,0mA", "最大功率 100W"]);
        lines.finish(&raw, "pd pdo", &mut |line| out.push(line.to_string()));
        lines.finish(&raw, "pd pdo", &mut |line| out.push(line.to_string()));
        assert_eq!(out.last().unwrap(), "no trailing newline");
        assert_eq!(out.len(), 4);
        assert_eq!(lines.text.trim(), out.join("\n"));
    }

    #[test]
    fn entry_drains_after_split_ready_and_errors_flush_the_tail() {
        struct Chunks(VecDeque<Vec<u8>>);
        impl Read for Chunks {
            fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
                if let Some(chunk) = self.0.pop_front() {
                    buf[..chunk.len()].copy_from_slice(&chunk);
                    Ok(chunk.len())
                } else {
                    Err(std::io::ErrorKind::BrokenPipe.into())
                }
            }
        }
        let mut input = Chunks(
            [
                b"entry pd\r\nrea".to_vec(),
                b"dy:5100mV,0mA\r\n".to_vec(),
                b"max power 100W\r\nlast status".to_vec(),
            ]
            .into(),
        );
        let mut out = Vec::new();
        let result = read_reply(
            &mut input,
            None,
            Duration::from_secs(1),
            IDLE_ENTRY,
            "entry pd",
            &mut |line| out.push(line.to_string()),
        );
        assert!(
            result.is_err(),
            "ready must not hide a subsequent transport error"
        );
        assert_eq!(out, ["ready:5100mV,0mA", "max power 100W", "last status"]);
    }

    #[test]
    fn cancellation_and_deadline_retain_unterminated_reply_lines() {
        use std::sync::{
            atomic::{AtomicBool, Ordering},
            Arc,
        };
        struct CancelAfter {
            cancel: Arc<AtomicBool>,
        }
        impl Read for CancelAfter {
            fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
                let bytes = b"pd req=2\nrequest pending";
                buf[..bytes.len()].copy_from_slice(bytes);
                self.cancel.store(true, Ordering::Release);
                Ok(bytes.len())
            }
        }
        let cancel = Arc::new(AtomicBool::new(false));
        let stop = StopSignal::new(Arc::new(AtomicBool::new(true)), cancel.clone());
        let mut out = Vec::new();
        let result = read_reply(
            &mut CancelAfter { cancel },
            Some(&stop),
            Duration::from_secs(1),
            IDLE_PD,
            "pd req=2",
            &mut |line| out.push(line.to_string()),
        );
        assert_eq!(result.unwrap_err().to_string(), "已取消");
        assert_eq!(out, ["request pending"]);

        let bytes = b"pd pdo\nready:5100mV,0mA";
        let mut input = std::io::Cursor::new(bytes);
        out.clear();
        let result = read_reply(
            &mut input,
            None,
            Duration::from_millis(2),
            IDLE_PD,
            "pd pdo",
            &mut |line| out.push(line.to_string()),
        )
        .unwrap();
        assert_eq!(out, ["ready:5100mV,0mA"]);
        assert_eq!(result.1, bytes);
    }
}
