// SPDX-FileCopyrightText: 2026 KHWLGH
// SPDX-License-Identifier: GPL-3.0-only
// For original project contributions; see COPYRIGHT.
//! WITRN HID device enumeration, report decoding and backlog-draining acquisition source.

use std::collections::{HashMap, HashSet};
use std::time::{Duration, Instant};

use hidapi::{DeviceInfo as HidDeviceInfo, HidApi};
use witrn_hid::{decode_general_sample, ReportKind};

use crate::{
    acquire, app_error, usb_port, DeviceData, DeviceFamily, DeviceInfo, KNOWN_DEVICES, WITRN_VID,
};

type PhysicalDeviceKey = (u16, u16, String);

fn physical_device_key(device: &DeviceInfo) -> PhysicalDeviceKey {
    // USB serial on WITRN hardware is a production-batch date, not a unit id.
    // Group by port first so two meters from the same batch stay distinct.
    let discriminator = device
        .usb_port
        .as_deref()
        .filter(|port| !port.is_empty())
        .map(|port| format!("usb:{port}"))
        .or_else(|| {
            device
                .serial_number
                .as_deref()
                .filter(|serial| !serial.is_empty())
                .map(|serial| format!("serial:{serial}"))
        })
        .unwrap_or_default();

    (device.vid, device.pid, discriminator)
}

pub(crate) fn prefer_vendor_defined_interfaces(mut devices: Vec<DeviceInfo>) -> Vec<DeviceInfo> {
    let vendor_defined_groups: HashSet<PhysicalDeviceKey> = devices
        .iter()
        .filter(|device| device.usage_page >= 0xFF00)
        .map(physical_device_key)
        .collect();

    devices.retain(|device| {
        !vendor_defined_groups.contains(&physical_device_key(device)) || device.usage_page >= 0xFF00
    });
    devices
}

pub(crate) fn model_name_for(vid: u16, pid: u16) -> String {
    KNOWN_DEVICES
        .iter()
        .find(|device| device.vid == vid && device.pid == pid)
        .map(|device| device.name.to_string())
        .unwrap_or_else(|| format!("Unknown WITRN device ({vid:04X}:{pid:04X})"))
}

pub(crate) fn device_info_from_hid(api: &HidApi, device_info: &HidDeviceInfo) -> DeviceInfo {
    let vid = device_info.vendor_id();
    let pid = device_info.product_id();
    let model_name = model_name_for(vid, pid);
    let usb_port = usb_port::usb_port_for_device(api, device_info);
    let display_name = usb_port::format_device_display_name(&model_name, usb_port.as_deref(), None);

    DeviceInfo {
        path: device_info.path().to_string_lossy().to_string(),
        vid,
        pid,
        serial_number: device_info.serial_number().map(str::to_string),
        usb_port,
        manufacturer: device_info.manufacturer_string().map(str::to_string),
        product: device_info.product_string().map(str::to_string),
        model_name,
        display_name,
        model_description: (!KNOWN_DEVICES
            .iter()
            .any(|device| device.vid == vid && device.pid == pid))
        .then(|| {
            app_error::AppError::message(
                "unknownWitrnDevice",
                [("vid", format!("{vid:04X}")), ("pid", format!("{pid:04X}"))],
            )
        }),
        interface_description: None,
        interface_number: device_info.interface_number(),
        usage_page: device_info.usage_page(),
        family: DeviceFamily::Witrn,
        controls: false,
        max_rate_hz: 100,
    }
}

pub(crate) fn finalize_device_infos(devices: Vec<DeviceInfo>) -> Vec<DeviceInfo> {
    let mut devices = prefer_vendor_defined_interfaces(devices);
    let mut physical_counts = HashMap::new();
    for device in &devices {
        *physical_counts
            .entry(physical_device_key(device))
            .or_insert(0usize) += 1;
    }

    let mut physical_indices = HashMap::new();
    for device in &mut devices {
        let key = physical_device_key(device);
        let interface_label = if physical_counts.get(&key).copied().unwrap_or(0) > 1 {
            let index = physical_indices.entry(key).or_insert(0usize);
            *index += 1;
            let interface = if device.interface_number >= 0 {
                device.interface_number.to_string()
            } else {
                index.to_string()
            };
            device.interface_description = Some(app_error::AppError::message(
                "deviceInterface",
                [
                    ("index", interface),
                    ("usage", format!("{:04X}", device.usage_page)),
                ],
            ));
            Some(if device.interface_number >= 0 {
                format!(
                    "Interface {} / Usage 0x{:04X}",
                    device.interface_number, device.usage_page
                )
            } else {
                format!("Interface {} / Usage 0x{:04X}", index, device.usage_page)
            })
        } else {
            None
        };

        device.display_name = usb_port::format_device_display_name(
            &device.model_name,
            device.usb_port.as_deref(),
            interface_label.as_deref(),
        );
    }

    devices
}

pub(crate) fn collect_supported_device_infos(api: &HidApi) -> Vec<DeviceInfo> {
    finalize_device_infos(
        api.device_list()
            .filter(|device_info| {
                let vid = device_info.vendor_id();
                let pid = device_info.product_id();
                vid == WITRN_VID
                    || KNOWN_DEVICES
                        .iter()
                        .any(|device| device.vid == vid && device.pid == pid)
            })
            .map(|device_info| device_info_from_hid(api, device_info))
            .collect(),
    )
}

/// 连续超时超过此时长且曾经读到过报告，视为拔线。
const UNPLUG_IDLE: Duration = Duration::from_secs(2);

/// 维简仪表按自己的节拍推送测量报告（K2 实测 10.00 ms），上位机不能调；
/// 一次排空的积压报告回推时间戳时，相邻两点最多相隔这么久。
const WITRN_REPORT_SPACING_US: u64 = 10_000;

/// 单次最多排空的报告数：hidapi 在 macOS 上每台设备最多缓存 30 份，Windows HID 默认环形缓冲 32 份。
pub(crate) const BACKLOG_DRAIN_CAP: usize = 64;

/// The small transport interface also lets boundary tests replay a real HID report queue.
pub(crate) trait HidReader: Send {
    fn read_timeout(&self, buf: &mut [u8], timeout_ms: i32) -> Result<usize, hidapi::HidError>;
}

impl HidReader for hidapi::HidDevice {
    fn read_timeout(&self, buf: &mut [u8], timeout_ms: i32) -> Result<usize, hidapi::HidError> {
        hidapi::HidDevice::read_timeout(self, buf, timeout_ms)
    }
}

/// 维简 HID 仪表：阻塞读 64 字节报告，再非阻塞排空主机已经排队的报告，统一打时间戳。
pub(crate) struct HidSource<D = hidapi::HidDevice> {
    pub(crate) device: D,
    epoch: Instant,
    buf: [u8; 64],
    last_report_at: Instant,
    saw_report: bool,
    /// 上一个测量样本的时间戳，排空的积压报告回推到它之后。
    pub(crate) last_sample_us: Option<u64>,
    drained: Vec<acquire::Payload>,
}

impl<D: HidReader> HidSource<D> {
    pub(crate) fn new(device: D, epoch: Instant) -> Self {
        Self {
            device,
            epoch,
            buf: [0u8; 64],
            last_report_at: Instant::now(),
            saw_report: false,
            last_sample_us: None,
            drained: Vec::with_capacity(BACKLOG_DRAIN_CAP),
        }
    }
}

fn report_payload(report: &[u8]) -> Option<acquire::Payload> {
    match ReportKind::of(report)? {
        ReportKind::General => parse_device_data(report).map(acquire::Payload::Sample),
        ReportKind::Pd => Some(acquire::Payload::Pd(report.to_vec())),
        _ => None,
    }
}

impl<D: HidReader> HidSource<D> {
    fn read_batch(
        &mut self,
        timeout_ms: i32,
        require_empty: bool,
        out: &mut Vec<acquire::Arrival>,
    ) -> Result<(), acquire::Stop> {
        let read = self.device.read_timeout(&mut self.buf, timeout_ms);
        let received_at = Instant::now();
        match read {
            Ok(0) => {
                if self.saw_report && self.last_report_at.elapsed() >= UNPLUG_IDLE {
                    return Err(acquire::Stop::Unplugged);
                }
            }
            Ok(read_len) => {
                self.last_report_at = received_at;
                self.saw_report = true;
                self.drained
                    .extend(report_payload(&self.buf[..read_len.min(self.buf.len())]));
                let mut newest_at = received_at;
                let mut empty = false;
                for _ in 1..BACKLOG_DRAIN_CAP {
                    match self.device.read_timeout(&mut self.buf, 0) {
                        Ok(len) if len > 0 => {
                            newest_at = Instant::now();
                            self.last_report_at = newest_at;
                            self.drained
                                .extend(report_payload(&self.buf[..len.min(self.buf.len())]));
                        }
                        Ok(_) => {
                            empty = true;
                            break;
                        }
                        Err(_) if require_empty => {
                            self.drained.clear();
                            return Err(acquire::Stop::Unplugged);
                        }
                        // A normal read error resurfaces on the next blocking read.
                        Err(_) => break,
                    }
                }
                // A boundary must not leave older reports for the new segment or rate.
                // Probe once at the cap; fail explicitly rather than seal an incomplete drain.
                if require_empty && !empty {
                    match self.device.read_timeout(&mut self.buf, 0) {
                        Ok(0) => {}
                        Ok(_) => {
                            self.drained.clear();
                            return Err(acquire::Stop::Failed(
                                "HID report queue exceeds the recording boundary drain capacity"
                                    .into(),
                            ));
                        }
                        Err(_) => {
                            self.drained.clear();
                            return Err(acquire::Stop::Unplugged);
                        }
                    }
                }
                self.last_sample_us = acquire::stamp_drained(
                    &mut self.drained,
                    self.last_sample_us,
                    newest_at.duration_since(self.epoch).as_micros() as u64,
                    WITRN_REPORT_SPACING_US,
                    out,
                );
            }
            Err(_) => return Err(acquire::Stop::Unplugged),
        }
        Ok(())
    }
}

impl<D: HidReader> acquire::Source for HidSource<D> {
    fn min_rate_ms(&self) -> u64 {
        10
    }

    fn read(&mut self, rate_ms: u64, out: &mut Vec<acquire::Arrival>) -> Result<(), acquire::Stop> {
        self.read_batch(rate_ms.min(20) as i32, false, out)
    }

    fn barrier(&mut self, out: &mut Vec<acquire::Arrival>) -> Result<(), acquire::Stop> {
        self.read_batch(0, true, out)
    }

    fn seal_boundary(&mut self, received_us: u64) {
        // The control timestamp is taken after ingesting the old queue. Reports that arrive
        // while it is being sealed must never be backdated before the new boundary.
        self.last_sample_us = Some(self.last_sample_us.unwrap_or(0).max(received_us));
    }
}

pub(crate) fn line_voltage(value: f32) -> Option<f32> {
    (0.0..=60.0).contains(&value).then_some(value)
}

pub(crate) fn parse_device_data(buf: &[u8]) -> Option<DeviceData> {
    let sample = decode_general_sample(buf).ok()?;
    Some(DeviceData {
        voltage: sample.voltage,
        current: sample.current,
        power: sample.power,
        dp: line_voltage(sample.dp),
        dn: line_voltage(sample.dn),
        cc1: sample.cc1,
        cc2: sample.cc2,
        temperature: sample.temperature,
        ah: Some(sample.ah),
        wh: Some(sample.wh),
    })
}
