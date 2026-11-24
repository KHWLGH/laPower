// SPDX-FileCopyrightText: 2026 KHWLGH
// SPDX-License-Identifier: GPL-3.0-only
// For original project contributions; see COPYRIGHT.
//! POWER-Z KM003C / KM002C sessions: the bulk poller that feeds the shared read loop,
//! and the trigger thread that owns the CDC port.
//!
//! The two run side by side on one meter. The poller reports sniffed Source_Capabilities
//! to the trigger through a [`PdoCache`], and tells it to forget the CDC port whenever
//! the bulk handle had to be reopened (the meter may have re-enumerated).

mod clock;
mod mapper;
#[cfg(test)]
mod tests;
pub(crate) mod trigger_worker;

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use km003c::meter::{self, Meter, Step};
use km003c::protocol::pd::PdEventKind;
use km003c::protocol::{Attribute, DataResponse, QueueSample};
use km003c::transport::{self, bulk};
use km003c::trigger::{wire_pdos, PdoCache, TriggerSession};
use km003c::StopSignal;
use tauri::{AppHandle, Emitter};

use self::clock::{next_on_grid, queue_timestamps, QueueClock, QueueDiagnostics};
use self::mapper::{map_adc, map_queue, witrn_pd_frame};
pub(crate) use self::trigger_worker::Km003cControl;
use self::trigger_worker::{trigger_loop, TriggerMsg};

use crate::acquire::{Arrival, Payload, Source, Stop};
use crate::{stream, usb_port, AppState, DeviceFamily, DeviceInfo};

/// Device paths of POWER-Z meters look like `km003c:{bus}#{address}`.
pub(crate) const PATH_PREFIX: &str = "km003c:";
/// Poll cadence: one GetData round trip every 10 ms feeds the 100/s selection grid.
const POLL_INTERVAL: Duration = Duration::from_millis(10);
/// Longest single wait inside `read`, so controls are answered promptly.
const MAX_WAIT: Duration = Duration::from_millis(20);

const QUEUE_POLL: Duration = Duration::from_millis(20);
const QUEUE_START_TIMEOUT: Duration = Duration::from_millis(1500);
const KM003C_MAX_RATE_HZ: u32 = 1000;
// A USB response holds at most 204 queue samples (4096 / 20 bytes).
const QUEUE_HISTORY: usize = 256;

/// Every POWER-Z meter on the bus. Enumeration problems are logged, never fatal: they
/// must not hide the WITRN meters listed alongside.
pub(crate) fn device_infos() -> Vec<DeviceInfo> {
    let devices = match bulk::list_devices() {
        Ok(devices) => devices,
        Err(error) => {
            eprintln!("枚举 POWER-Z 设备失败: {error:#}");
            return Vec::new();
        }
    };
    devices
        .into_iter()
        .map(|device| {
            let model_name = format!("POWER-Z {}", transport::model_name(device.pid));
            // Without a port path, the unit's serial is what tells two meters apart.
            let serial_label = device
                .serial
                .as_deref()
                .filter(|serial| !serial.trim().is_empty() && device.usb_port.is_none())
                .map(|serial| format!("SN {serial}"));
            let display_name = usb_port::format_device_display_name(
                &model_name,
                device.usb_port.as_deref(),
                serial_label.as_deref(),
            );
            DeviceInfo {
                path: format!("{PATH_PREFIX}{}#{}", device.bus_id, device.address),
                vid: device.vid,
                pid: device.pid,
                serial_number: device.serial,
                usb_port: device.usb_port,
                manufacturer: Some("ChargerLAB".into()),
                product: device.product,
                model_name,
                display_name,
                model_description: None,
                interface_description: None,
                interface_number: i32::from(bulk::INTERFACE_VENDOR),
                usage_page: 0,
                family: DeviceFamily::Km003c,
                controls: true,
                max_rate_hz: KM003C_MAX_RATE_HZ,
            }
        })
        .collect()
}

fn parse_location(location: &str) -> Result<(String, u8), String> {
    let (bus, address) = location
        .rsplit_once('#')
        .ok_or_else(|| format!("无效的 POWER-Z 设备路径: {location}"))?;
    let address = address
        .parse()
        .map_err(|_| format!("无效的 POWER-Z 设备路径: {location}"))?;
    Ok((bus.to_string(), address))
}

/// Open the meter, then start the stream threads and the trigger thread.
///
/// The bulk handshake happens before a generation is taken, so a driver problem is a
/// plain connect error rather than a stream that opens and immediately fails.
pub(crate) fn connect(
    path: &str,
    location: &str,
    state: &AppState,
    app: AppHandle,
) -> Result<stream::Open, String> {
    let (bus_id, address) = parse_location(location)?;
    let info = device_infos()
        .into_iter()
        .find(|device| device.path == path)
        .ok_or("找不到指定设备")?;
    let (mut task_slot, had_session) = crate::stream_commands::claim_device_slot(state)?;
    let mut meter = match Meter::open(&bus_id, address, info.serial_number.as_deref()) {
        Ok(meter) => meter,
        Err(error) => {
            crate::stream_commands::report_open_failure(state, &app, had_session);
            return Err(format!("无法打开设备: {error:#}"));
        }
    };
    let serial = info
        .serial_number
        .clone()
        .filter(|serial| !serial.trim().is_empty() && serial != "-");
    let pdo_cache = PdoCache::default();
    read_firmware_metadata(&mut meter, &pdo_cache);
    let (trigger_tx, trigger_rx) = mpsc::channel();
    let busy = Arc::new(AtomicBool::new(false));
    let cancel = Arc::new(AtomicBool::new(false));
    let trigger_app = app.clone();
    let source_app = app.clone();
    let source_rate = Arc::clone(&state.sample_rate);
    let open = crate::stream_commands::launch_stream(state, app, &mut task_slot, info, |seed| {
        let session = TriggerSession::new(
            serial,
            StopSignal::new(Arc::clone(&seed.running), Arc::clone(&cancel)),
        );
        let running = Arc::clone(&seed.running);
        let generation = seed.generation;
        let cache = pdo_cache.clone();
        let trigger_join = thread::spawn(move || {
            trigger_loop(session, trigger_rx, running, cache, trigger_app, generation)
        });
        let source = Km003cSource {
            meter,
            epoch: seed.epoch,
            next_poll: Instant::now(),
            trigger_tx: trigger_tx.clone(),
            pdo_cache,
            app: source_app,
            sample_rate: source_rate,
            hardware_id: None,
            queue: None,
            queue_failed: false,
            rate_override: None,
            last_temperature: None,
            queue_diagnostics: QueueDiagnostics::default(),
        };
        (source, vec![trigger_join])
    });
    *state.km003c.lock().map_err(|_| "KM003C 控制状态已损坏")? = Some(Km003cControl {
        generation: open.generation,
        tx: trigger_tx,
        busy,
        cancel,
    });
    Ok(open)
}

struct Km003cSource {
    meter: Meter,
    epoch: Instant,
    next_poll: Instant,
    trigger_tx: mpsc::Sender<TriggerMsg>,
    pdo_cache: PdoCache,
    app: AppHandle,
    sample_rate: Arc<AtomicU64>,
    /// HardwareID is stable for the physical meter. Keep it across queue restarts and
    /// USB re-enumeration so a rate toggle does not repeat the encrypted memory exchange.
    hardware_id: Option<[u8; 12]>,
    queue: Option<QueueMode>,
    queue_failed: bool,
    rate_override: Option<u64>,
    last_temperature: Option<f32>,
    /// Connection totals survive queue restarts and rate changes.
    queue_diagnostics: QueueDiagnostics,
}

struct QueueMode {
    rate_index: u8,
    started: Instant,
    saw_sample: bool,
    clock: QueueClock,
    recent: VecDeque<QueueSample>,
}

impl Source for Km003cSource {
    fn min_rate_ms(&self) -> u64 {
        1
    }

    fn read(&mut self, rate_ms: u64, out: &mut Vec<Arrival>) -> Result<(), Stop> {
        if rate_ms == 1 {
            return self.read_queue(out);
        }
        self.stop_queue();
        let now = Instant::now();
        if now < self.next_poll {
            thread::sleep((self.next_poll - now).min(MAX_WAIT));
            return Ok(());
        }
        let step = self.meter.step(Attribute::ADC_AND_PD, now);
        let received_us = self.epoch.elapsed().as_micros() as u64;
        self.next_poll = next_on_grid(self.next_poll, POLL_INTERVAL, Instant::now());
        match step {
            Ok(Step::Data(response)) => {
                self.deliver(response, received_us, out);
                Ok(())
            }
            Ok(Step::Idle(wait)) => {
                self.next_poll = Instant::now() + wait;
                Ok(())
            }
            Ok(Step::Reopened) => {
                self.refresh_metadata();
                let _ = self.trigger_tx.send(TriggerMsg::DropCdc);
                Ok(())
            }
            Err(meter::Stop::Unplugged) => Err(Stop::Unplugged),
            Err(meter::Stop::Failed(message)) => Err(Stop::Failed(message)),
        }
    }

    fn barrier(&mut self, out: &mut Vec<Arrival>) -> Result<(), Stop> {
        // A control boundary must first drain one response already waiting in the
        // meter. Otherwise a queue batch can be stamped into the next recording
        // segment even though it arrived before the boundary was requested.
        let queue_mode = self.queue.is_some();
        let attr = if queue_mode {
            Attribute::ADC | Attribute::ADC_QUEUE | Attribute::PD_PACKET
        } else {
            Attribute::ADC_AND_PD
        };
        let period = if queue_mode {
            QUEUE_POLL
        } else {
            POLL_INTERVAL
        };
        let now = Instant::now();
        let step = self.meter.step(attr, now);
        let received_us = self.epoch.elapsed().as_micros() as u64;
        self.next_poll = next_on_grid(self.next_poll, period, Instant::now());
        match step {
            Ok(Step::Data(response)) => {
                if queue_mode {
                    self.deliver_queue(response, received_us, out)?;
                } else {
                    self.deliver(response, received_us, out);
                }
                Ok(())
            }
            Ok(Step::Idle(wait)) => {
                self.next_poll = Instant::now() + wait;
                Ok(())
            }
            Ok(Step::Reopened) => {
                if queue_mode {
                    self.stop_queue();
                }
                self.refresh_metadata();
                let _ = self.trigger_tx.send(TriggerMsg::DropCdc);
                Ok(())
            }
            Err(meter::Stop::Unplugged) => Err(Stop::Unplugged),
            Err(meter::Stop::Failed(message)) => Err(Stop::Failed(message)),
        }
    }

    fn set_rate(&mut self, rate_ms: u64) {
        if rate_ms == 1 {
            self.queue_failed = false;
            self.next_poll = Instant::now();
        } else {
            self.stop_queue();
            self.queue_failed = false;
        }
    }

    fn rate_override(&mut self) -> Option<u64> {
        self.rate_override.take()
    }
}

fn read_firmware_metadata(meter: &mut Meter, cache: &PdoCache) {
    let record = meter
        .device_mut()
        .map(|device| device.memory_read(0x0000_4420, 64));
    let (version, diagnostic) = match record {
        Some(Ok(bytes)) => match km003c::evidence::firmware_version(&bytes) {
            Some(version) => (Some(version), None),
            None => (
                None,
                Some(format!(
                    "Unknown KM003C firmware record at 0x4420: {bytes:02X?}"
                )),
            ),
        },
        Some(Err(error)) => (
            None,
            Some(format!("KM003C firmware metadata unavailable: {error:#}")),
        ),
        None => (
            None,
            Some("Bulk device unavailable while reading firmware metadata".into()),
        ),
    };
    if let Some(detail) = &diagnostic {
        eprintln!("{detail}");
    }
    cache.set_firmware_version(version);
    cache.set_firmware_diagnostic(diagnostic);
}

impl Km003cSource {
    fn refresh_metadata(&mut self) {
        self.pdo_cache.clear();
        read_firmware_metadata(&mut self.meter, &self.pdo_cache);
    }

    fn read_queue(&mut self, out: &mut Vec<Arrival>) -> Result<(), Stop> {
        if self.queue.is_none() {
            if self.queue_failed {
                // The reader will have lowered the shared setting after the first failure.
                return self.read_adc(out);
            }
            if let Err(error) = self.start_queue() {
                self.queue_failed = true;
                self.rate_override = Some(10);
                self.sample_rate.store(10, Ordering::Release);
                let _ = self.app.emit(
                    "km003c-high-rate",
                    serde_json::json!({ "ok": false, "message": error,
                        "description": crate::app_error::AppError::new("backendFailure", error.clone()) }),
                );
                return self.read_adc(out);
            }
        }
        let now = Instant::now();
        if now < self.next_poll {
            thread::sleep((self.next_poll - now).min(MAX_WAIT));
            return Ok(());
        }
        let step = self.meter.step(
            Attribute::ADC | Attribute::ADC_QUEUE | Attribute::PD_PACKET,
            now,
        );
        let received_us = self.epoch.elapsed().as_micros() as u64;
        self.next_poll = next_on_grid(self.next_poll, QUEUE_POLL, Instant::now());
        match step {
            Ok(Step::Data(response)) => {
                self.deliver_queue(response, received_us, out)?;
                if self.queue.as_ref().is_some_and(|mode| !mode.saw_sample)
                    && self
                        .queue
                        .as_ref()
                        .is_some_and(|mode| mode.started.elapsed() >= QUEUE_START_TIMEOUT)
                {
                    self.fail_queue("AdcQueue 在 1.5 秒内没有返回样本".into());
                }
                Ok(())
            }
            Ok(Step::Idle(wait)) => {
                self.next_poll = Instant::now() + wait;
                Ok(())
            }
            Ok(Step::Reopened) => {
                self.stop_queue();
                self.refresh_metadata();
                let _ = self.trigger_tx.send(TriggerMsg::DropCdc);
                Ok(())
            }
            Err(meter::Stop::Unplugged) => Err(Stop::Unplugged),
            Err(meter::Stop::Failed(message)) => Err(Stop::Failed(message)),
        }
    }

    fn read_adc(&mut self, out: &mut Vec<Arrival>) -> Result<(), Stop> {
        let now = Instant::now();
        if now < self.next_poll {
            thread::sleep((self.next_poll - now).min(MAX_WAIT));
            return Ok(());
        }
        let step = self.meter.step(Attribute::ADC_AND_PD, now);
        let received_us = self.epoch.elapsed().as_micros() as u64;
        self.next_poll = next_on_grid(self.next_poll, POLL_INTERVAL, Instant::now());
        match step {
            Ok(Step::Data(response)) => {
                self.deliver(response, received_us, out);
                Ok(())
            }
            Ok(Step::Idle(wait)) => {
                self.next_poll = Instant::now() + wait;
                Ok(())
            }
            Ok(Step::Reopened) => {
                self.refresh_metadata();
                let _ = self.trigger_tx.send(TriggerMsg::DropCdc);
                Ok(())
            }
            Err(meter::Stop::Unplugged) => Err(Stop::Unplugged),
            Err(meter::Stop::Failed(message)) => Err(Stop::Failed(message)),
        }
    }

    fn start_queue(&mut self) -> Result<(), String> {
        let hardware_id = if let Some(hardware_id) = self.hardware_id {
            hardware_id
        } else {
            let device = self
                .meter
                .device_mut()
                .ok_or_else(|| "Bulk 设备当前不可用".to_string())?;
            let hardware_id = device
                .memory_read(0x4001_0450, 12)
                .map_err(|error| format!("读取 HardwareID 失败: {error:#}"))?;
            let hardware_id: [u8; 12] = hardware_id
                .try_into()
                .map_err(|_| "HardwareID 长度错误".to_string())?;
            self.hardware_id = Some(hardware_id);
            hardware_id
        };
        let timestamp_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|error| format!("系统时钟错误: {error}"))?
            .as_millis() as u64;
        let device = self
            .meter
            .device_mut()
            .ok_or_else(|| "Bulk 设备当前不可用".to_string())?;
        let level = device
            .stream_auth(hardware_id, timestamp_ms)
            .map_err(|error| format!("StreamingAuth 失败: {error:#}"))?;
        device
            .start_graph(3)
            .map_err(|error| format!("StartGraph 失败: {error:#}"))?;
        let _ = self.app.emit(
            "km003c-high-rate",
            serde_json::json!({ "ok": true, "auth_level": level }),
        );
        self.queue = Some(QueueMode {
            rate_index: 3,
            started: Instant::now(),
            saw_sample: false,
            clock: QueueClock::default(),
            recent: VecDeque::with_capacity(QUEUE_HISTORY),
        });
        self.next_poll = Instant::now();
        Ok(())
    }

    fn stop_queue(&mut self) {
        if self.queue.take().is_some() {
            if let Some(device) = self.meter.device_mut() {
                let _ = device.stop_graph();
            }
        }
    }

    fn fail_queue(&mut self, message: String) {
        self.stop_queue();
        self.queue_failed = true;
        self.rate_override = Some(10);
        self.sample_rate.store(10, Ordering::Release);
        let _ = self.app.emit(
            "km003c-high-rate",
            serde_json::json!({ "ok": false, "message": message,
                "description": crate::app_error::AppError::new("backendFailure", message.clone()) }),
        );
    }

    /// The sample goes first, so PD rows from the same poll carry its V/I.
    fn deliver(&self, response: DataResponse, received_us: u64, out: &mut Vec<Arrival>) {
        if let Some(adc) = response.adc {
            let data = map_adc(&adc);
            self.pdo_cache.voltage_cache().record(
                self.epoch + Duration::from_micros(received_us),
                (data.voltage * 1000.0).round() as u32,
            );
            out.push(Arrival {
                received_us,
                payload: Payload::Sample(data),
            });
        }
        for event in response.pd_events {
            match event.kind {
                PdEventKind::Message(message) => {
                    self.pdo_cache.record_pd_message(&message);
                    if message.is_source_capabilities() {
                        self.pdo_cache.update(wire_pdos(&message.pdos));
                    }
                    if let Some(frame) = witrn_pd_frame(&message) {
                        out.push(Arrival {
                            received_us,
                            payload: Payload::Pd(frame),
                        });
                    }
                }
                PdEventKind::Disconnect => out.push(Arrival {
                    received_us,
                    payload: Payload::PdReset,
                }),
                PdEventKind::Connect | PdEventKind::Unknown { .. } => {}
            }
        }
    }

    fn deliver_queue(
        &mut self,
        response: DataResponse,
        received_us: u64,
        out: &mut Vec<Arrival>,
    ) -> Result<(), Stop> {
        if let Some(adc) = response.adc {
            let temperature = adc.temp_c() as f32;
            self.last_temperature = (-40.0..=150.0)
                .contains(&temperature)
                .then_some(temperature);
        }
        let Some(mode) = self.queue.as_mut() else {
            return Ok(());
        };
        let (skip, timestamps) = queue_timestamps(
            &mut mode.clock,
            &mode.recent,
            &response.queue,
            received_us,
            mode.rate_index,
        )
        .map_err(Stop::Failed)?;
        let voltages = self.pdo_cache.voltage_cache();
        for (sample, timestamp_us) in response.queue[skip..].iter().zip(timestamps) {
            if mode.recent.len() == QUEUE_HISTORY {
                mode.recent.pop_front();
            }
            mode.recent.push_back(*sample);
            let mut data = map_queue(sample, mode.rate_index);
            data.temperature = self.last_temperature;
            voltages.record(
                self.epoch + Duration::from_micros(timestamp_us),
                (data.voltage * 1000.0).round() as u32,
            );
            out.push(Arrival {
                received_us: timestamp_us,
                payload: Payload::Sample(data),
            });
            mode.saw_sample = true;
        }
        let holes = mode.clock.take_holes();
        self.queue_diagnostics.add(holes, skip);
        if let Some((holes, replays)) = self.queue_diagnostics.report(received_us, false) {
            eprintln!("KM003C AdcQueue 连接累计: 序号空洞估计 {holes}, 已核实重放 {replays}");
        }
        self.deliver_pd(&response, received_us, out);
        Ok(())
    }

    fn deliver_pd(&self, response: &DataResponse, received_us: u64, out: &mut Vec<Arrival>) {
        for event in &response.pd_events {
            match &event.kind {
                PdEventKind::Message(message) => {
                    self.pdo_cache.record_pd_message(message);
                    if message.is_source_capabilities() {
                        self.pdo_cache.update(wire_pdos(&message.pdos));
                    }
                    if let Some(frame) = witrn_pd_frame(message) {
                        out.push(Arrival {
                            received_us,
                            payload: Payload::Pd(frame),
                        });
                    }
                }
                PdEventKind::Disconnect => out.push(Arrival {
                    received_us,
                    payload: Payload::PdReset,
                }),
                PdEventKind::Connect | PdEventKind::Unknown { .. } => {}
            }
        }
    }
}

impl Drop for Km003cSource {
    fn drop(&mut self) {
        self.stop_queue();
        if let Some((holes, replays)) = self
            .queue_diagnostics
            .report(self.epoch.elapsed().as_micros() as u64, true)
        {
            eprintln!("KM003C AdcQueue 连接结束累计: 序号空洞估计 {holes}, 已核实重放 {replays}");
        }
    }
}
