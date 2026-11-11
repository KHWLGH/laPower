// SPDX-FileCopyrightText: 2026 KHWLGH
// SPDX-License-Identifier: GPL-3.0-only
// For original project contributions; see COPYRIGHT.
//! VideoToolbox hardware encoding for macOS.
//!
//! VideoToolbox is the platform H.264/HEVC encoder and always runs on the media engine when the
//! Mac supports the combination; the session asks for the hardware encoder and then reads back
//! whether it actually got one, so the dialog can report the truth. The frames come from the
//! shared portable renderer, and the access units are muxed by [super::mp4] exactly like the
//! Linux path.
//!
//! The bindings are written by hand instead of pulling in the objc2 framework crates: only a
//! handful of C functions and two constants are needed, and this keeps the macOS dependency list
//! as small as it was.

use std::ffi::{c_char, c_void, CString};
use std::ptr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use super::model::{Acceleration, Codec, VideoCapability, VideoOptions};
use super::mp4;
use super::portable::{Encoder as Backend, Sample};

type OSStatus = i32;
type CFTypeRef = *const c_void;
type CFStringRef = *const c_void;
type CFNumberRef = *const c_void;
type CFDictionaryRef = *const c_void;
type CFArrayRef = *const c_void;
type CVImageBufferRef = *mut c_void;
type CMSampleBufferRef = *mut c_void;
type CMBlockBufferRef = *mut c_void;
type CMFormatDescriptionRef = *mut c_void;
type VTCompressionSessionRef = *mut c_void;

/// kCMVideoCodecType_H264 ('avc1').
const CODEC_H264: u32 = 0x6176_6331;
/// kCMVideoCodecType_HEVC ('hvc1').
const CODEC_HEVC: u32 = 0x6876_6331;
/// kCVPixelFormatType_32BGRA.
const PIXEL_FORMAT_BGRA: u32 = 0x4247_5241;
const CF_STRING_ENCODING_UTF8: u32 = 0x0800_0100;
/// CFNumberType: SInt32.
const CF_NUMBER_SINT32: i32 = 3;
/// kCMTimeFlags_Valid.
const CM_TIME_FLAGS_VALID: u32 = 1;

/// Core Media time value; the layout is stable across every Apple platform.
#[repr(C)]
#[derive(Clone, Copy)]
struct CMTime {
    value: i64,
    timescale: i32,
    flags: u32,
    epoch: i64,
}

/// kCMTimeInvalid: no flags set, so the timestamp does not describe a time.
const CM_TIME_INVALID: CMTime = CMTime {
    value: 0,
    timescale: 0,
    flags: 0,
    epoch: 0,
};

#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    static kCFBooleanTrue: CFTypeRef;
    static kCFBooleanFalse: CFTypeRef;
    // CFType callbacks retain the keys and values if VideoToolbox retains the specification.
    static kCFTypeDictionaryKeyCallBacks: [usize; 6];
    static kCFTypeDictionaryValueCallBacks: [usize; 5];
    fn CFStringCreateWithCString(
        allocator: CFTypeRef,
        string: *const c_char,
        encoding: u32,
    ) -> CFStringRef;
    fn CFNumberCreate(allocator: CFTypeRef, kind: i32, value: *const c_void) -> CFNumberRef;
    fn CFRelease(value: CFTypeRef);
    fn CFBooleanGetValue(value: CFTypeRef) -> u8;
    fn CFArrayGetCount(array: CFArrayRef) -> isize;
    fn CFArrayGetValueAtIndex(array: CFArrayRef, index: isize) -> *const c_void;
    fn CFDictionaryCreate(
        allocator: CFTypeRef,
        keys: *const CFTypeRef,
        values: *const CFTypeRef,
        count: isize,
        key_callbacks: *const c_void,
        value_callbacks: *const c_void,
    ) -> CFDictionaryRef;
    fn CFDictionaryContainsKey(dictionary: CFDictionaryRef, key: *const c_void) -> u8;
}

#[link(name = "CoreVideo", kind = "framework")]
extern "C" {
    fn CVPixelBufferCreate(
        allocator: CFTypeRef,
        width: usize,
        height: usize,
        pixel_format: u32,
        attributes: CFTypeRef,
        out: *mut CVImageBufferRef,
    ) -> i32;
    fn CVPixelBufferLockBaseAddress(buffer: CVImageBufferRef, flags: u64) -> i32;
    fn CVPixelBufferUnlockBaseAddress(buffer: CVImageBufferRef, flags: u64) -> i32;
    fn CVPixelBufferGetBaseAddress(buffer: CVImageBufferRef) -> *mut c_void;
    fn CVPixelBufferGetBytesPerRow(buffer: CVImageBufferRef) -> usize;
    fn CVPixelBufferRelease(buffer: CVImageBufferRef);
}

#[link(name = "CoreMedia", kind = "framework")]
extern "C" {
    fn CMSampleBufferGetDataBuffer(sample: CMSampleBufferRef) -> CMBlockBufferRef;
    fn CMSampleBufferGetFormatDescription(sample: CMSampleBufferRef) -> CMFormatDescriptionRef;
    fn CMSampleBufferGetSampleAttachmentsArray(
        sample: CMSampleBufferRef,
        create_if_necessary: u8,
    ) -> CFArrayRef;
    fn CMBlockBufferGetDataPointer(
        buffer: CMBlockBufferRef,
        offset: usize,
        length_at_offset: *mut usize,
        total_length: *mut usize,
        data: *mut *mut c_char,
    ) -> OSStatus;
    fn CMBlockBufferCopyDataBytes(
        buffer: CMBlockBufferRef,
        offset: usize,
        length: usize,
        destination: *mut c_void,
    ) -> OSStatus;
    fn CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
        description: CMFormatDescriptionRef,
        index: usize,
        pointer: *mut *const u8,
        size: *mut usize,
        count: *mut usize,
        header_length: *mut i32,
    ) -> OSStatus;
    fn CMVideoFormatDescriptionGetHEVCParameterSetAtIndex(
        description: CMFormatDescriptionRef,
        index: usize,
        pointer: *mut *const u8,
        size: *mut usize,
        count: *mut usize,
        header_length: *mut i32,
    ) -> OSStatus;
}

#[link(name = "VideoToolbox", kind = "framework")]
extern "C" {
    fn VTCompressionSessionCreate(
        allocator: CFTypeRef,
        width: i32,
        height: i32,
        codec: u32,
        encoder_specification: CFTypeRef,
        source_image_buffer_attributes: CFTypeRef,
        compressed_data_allocator: CFTypeRef,
        output_callback: Option<
            unsafe extern "C" fn(*mut c_void, *mut c_void, OSStatus, u32, CMSampleBufferRef),
        >,
        output_callback_ref_con: *mut c_void,
        session_out: *mut VTCompressionSessionRef,
    ) -> OSStatus;
    fn VTCompressionSessionSetProperty(
        session: VTCompressionSessionRef,
        key: CFStringRef,
        value: CFTypeRef,
    ) -> OSStatus;
    fn VTCompressionSessionPrepareToEncodeFrames(session: VTCompressionSessionRef) -> OSStatus;
    fn VTCompressionSessionEncodeFrame(
        session: VTCompressionSessionRef,
        image_buffer: CVImageBufferRef,
        presentation_time_stamp: CMTime,
        duration: CMTime,
        frame_properties: CFTypeRef,
        source_frame_ref_con: *mut c_void,
        info_flags_out: *mut u32,
    ) -> OSStatus;
    fn VTCompressionSessionCompleteFrames(
        session: VTCompressionSessionRef,
        complete_until: CMTime,
    ) -> OSStatus;
    fn VTCompressionSessionInvalidate(session: VTCompressionSessionRef);
    fn VTSessionCopyProperty(
        session: VTCompressionSessionRef,
        key: CFStringRef,
        allocator: CFTypeRef,
        value_out: *mut CFTypeRef,
    ) -> OSStatus;
}

/// One encoded access unit, still length prefixed the way an MP4 sample needs it.
struct Packet {
    data: Vec<u8>,
    keyframe: bool,
}

/// State shared with the VideoToolbox output callback.
#[derive(Default)]
struct Inner {
    packets: Mutex<Vec<Packet>>,
    config: Mutex<Option<Vec<u8>>>,
    failure: Mutex<Option<String>>,
    codec: Option<Codec>,
}

impl Inner {
    fn fail(&self, message: String) {
        if let Ok(mut slot) = self.failure.lock() {
            *slot = Some(message);
        }
    }
}

/// VideoToolbox H.264 / HEVC encoder session.
pub(super) struct Vt {
    inner: Arc<Inner>,
    session: VTCompressionSessionRef,
    /// The reference handed to VideoToolbox, reclaimed when the session is released.
    refcon: *mut c_void,
    width: usize,
    height: usize,
    fps: u32,
    hardware: bool,
}

impl Vt {
    pub(super) fn new(options: &VideoOptions) -> Result<Self, String> {
        if !options.width.is_multiple_of(2) || !options.height.is_multiple_of(2) {
            return Err("VideoToolbox needs even dimensions".into());
        }
        let inner = Arc::new(Inner {
            codec: Some(options.codec),
            ..Default::default()
        });
        let refcon = Arc::into_raw(Arc::clone(&inner))
            .cast_mut()
            .cast::<c_void>();
        let hardware = options.acceleration != Acceleration::Software;
        let keys = [
            cf_string("EnableHardwareAcceleratedVideoEncoder"),
            cf_string("RequireHardwareAcceleratedVideoEncoder"),
        ];
        let values = unsafe {
            let enabled = if hardware {
                kCFBooleanTrue
            } else {
                kCFBooleanFalse
            };
            [enabled, enabled]
        };
        let specification = unsafe {
            CFDictionaryCreate(
                ptr::null(),
                keys.as_ptr(),
                values.as_ptr(),
                2,
                ptr::addr_of!(kCFTypeDictionaryKeyCallBacks).cast(),
                ptr::addr_of!(kCFTypeDictionaryValueCallBacks).cast(),
            )
        };
        if specification.is_null() {
            unsafe {
                for key in keys {
                    CFRelease(key);
                }
                drop(Arc::from_raw(refcon.cast::<Inner>()));
            }
            return Err("cannot create the VideoToolbox encoder specification".into());
        }
        let mut session: VTCompressionSessionRef = ptr::null_mut();
        let status = unsafe {
            VTCompressionSessionCreate(
                ptr::null(),
                options.width as i32,
                options.height as i32,
                codec_type(options.codec),
                specification,
                ptr::null(),
                ptr::null(),
                Some(output_sample),
                refcon,
                &mut session,
            )
        };
        unsafe {
            CFRelease(specification);
            for key in keys {
                CFRelease(key);
            }
        }
        if status != 0 || session.is_null() {
            // The session never started, so reclaim the reference handed to VideoToolbox.
            unsafe { drop(Arc::from_raw(refcon.cast::<Inner>())) };
            return Err(format!(
                "VideoToolbox cannot create a {} session (status {status})",
                options.codec.label()
            ));
        }
        let mut encoder = Self {
            inner,
            session,
            refcon,
            width: options.width as usize,
            height: options.height as usize,
            fps: options.fps.max(1),
            hardware: true,
        };
        encoder.set_bool("RealTime", false)?;
        encoder.set_bool("AllowFrameReordering", false)?;
        encoder.set_i32("AverageBitRate", options.bitrate() as _)?;
        encoder.set_i32("ExpectedFrameRate", options.fps as i32)?;
        // One keyframe is enough for a report nobody scrubs, matching the Windows path.
        encoder.set_i32(
            "MaxKeyFrameInterval",
            options.frames().min(i32::MAX as usize) as i32,
        )?;
        let status = unsafe { VTCompressionSessionPrepareToEncodeFrames(encoder.session) };
        if status != 0 {
            return Err(format!(
                "VideoToolbox cannot prepare the {} session (status {status})",
                options.codec.label()
            ));
        }
        encoder.hardware = encoder.using_hardware()?;
        if encoder.hardware != hardware {
            return Err("VideoToolbox did not select the requested encoding mode".into());
        }
        Ok(encoder)
    }

    /// True when the session really got the hardware encoder; VideoToolbox falls back quietly.
    fn using_hardware(&self) -> Result<bool, String> {
        let key = cf_string("UsingHardwareAcceleratedVideoEncoder");
        let mut value: CFTypeRef = ptr::null();
        let status = unsafe { VTSessionCopyProperty(self.session, key, ptr::null(), &mut value) };
        unsafe { CFRelease(key) };
        if status != 0 || value.is_null() {
            if !value.is_null() {
                unsafe { CFRelease(value) };
            }
            return Err(format!(
                "cannot verify the VideoToolbox encoder (status {status})"
            ));
        }
        let enabled = unsafe { CFBooleanGetValue(value) } != 0;
        unsafe { CFRelease(value) };
        Ok(enabled)
    }

    fn set_bool(&self, key: &str, value: bool) -> Result<(), String> {
        let property = cf_string(key);
        let setting = unsafe {
            if value {
                kCFBooleanTrue
            } else {
                kCFBooleanFalse
            }
        };
        let status = unsafe { VTCompressionSessionSetProperty(self.session, property, setting) };
        unsafe { CFRelease(property) };
        if status != 0 {
            return Err(format!(
                "VideoToolbox rejected the {key} setting (status {status})"
            ));
        }
        Ok(())
    }

    fn set_i32(&self, key: &str, value: i32) -> Result<(), String> {
        let property = cf_string(key);
        let setting = cf_number(value);
        let status = unsafe { VTCompressionSessionSetProperty(self.session, property, setting) };
        unsafe {
            CFRelease(property);
            CFRelease(setting);
        }
        if status != 0 {
            return Err(format!(
                "VideoToolbox rejected the {key} setting (status {status})"
            ));
        }
        Ok(())
    }

    /// Copy the RGBA frame into a fresh BGRA pixel buffer owned by CoreVideo.
    fn pixel_buffer(&self, rgba: &[u8]) -> Result<CVImageBufferRef, String> {
        let mut buffer: CVImageBufferRef = ptr::null_mut();
        let status = unsafe {
            CVPixelBufferCreate(
                ptr::null(),
                self.width,
                self.height,
                PIXEL_FORMAT_BGRA,
                ptr::null(),
                &mut buffer,
            )
        };
        if status != 0 || buffer.is_null() {
            return Err(format!("cannot allocate a video frame (status {status})"));
        }
        unsafe {
            if CVPixelBufferLockBaseAddress(buffer, 0) != 0 {
                CVPixelBufferRelease(buffer);
                return Err("cannot lock a video frame".into());
            }
            let base = CVPixelBufferGetBaseAddress(buffer).cast::<u8>();
            let stride = CVPixelBufferGetBytesPerRow(buffer);
            if base.is_null() || stride < self.width * 4 {
                CVPixelBufferUnlockBaseAddress(buffer, 0);
                CVPixelBufferRelease(buffer);
                return Err("VideoToolbox returned an unusable video frame".into());
            }
            for y in 0..self.height {
                let source = &rgba[y * self.width * 4..(y + 1) * self.width * 4];
                let row = std::slice::from_raw_parts_mut(base.add(y * stride), self.width * 4);
                for x in 0..self.width {
                    row[x * 4] = source[x * 4 + 2];
                    row[x * 4 + 1] = source[x * 4 + 1];
                    row[x * 4 + 2] = source[x * 4];
                    row[x * 4 + 3] = 255;
                }
            }
            CVPixelBufferUnlockBaseAddress(buffer, 0);
        }
        Ok(buffer)
    }

    fn drain(&self, out: &mut Vec<Sample>) -> Result<(), String> {
        let failure = self
            .inner
            .failure
            .lock()
            .ok()
            .and_then(|mut slot| slot.take());
        if let Some(failure) = failure {
            return Err(failure);
        }
        let packets = self
            .inner
            .packets
            .lock()
            .map_err(|_| "the VideoToolbox output queue is poisoned".to_owned())?
            .split_off(0);
        for packet in packets {
            out.push(Sample {
                data: packet.data,
                keyframe: packet.keyframe,
            });
        }
        Ok(())
    }
}

impl Backend for Vt {
    fn name(&self) -> &'static str {
        if self.hardware {
            "hardware"
        } else {
            "software"
        }
    }

    fn config(&self) -> Option<Vec<u8>> {
        self.inner.config.lock().ok().and_then(|slot| slot.clone())
    }

    fn push(
        &mut self,
        rgba: &[u8],
        index: usize,
        cancel: &AtomicBool,
        out: &mut Vec<Sample>,
    ) -> Result<(), String> {
        if cancel.load(Ordering::Acquire) {
            return Err("video encoding was cancelled".into());
        }
        let buffer = self.pixel_buffer(rgba)?;
        let timescale = self.fps as i32;
        let timestamp = CMTime {
            value: index as i64,
            timescale,
            flags: CM_TIME_FLAGS_VALID,
            epoch: 0,
        };
        let duration = CMTime {
            value: 1,
            timescale,
            flags: CM_TIME_FLAGS_VALID,
            epoch: 0,
        };
        let status = unsafe {
            VTCompressionSessionEncodeFrame(
                self.session,
                buffer,
                timestamp,
                duration,
                ptr::null(),
                ptr::null_mut(),
                ptr::null_mut(),
            )
        };
        // VideoToolbox retains the pixel buffer until the frame has been encoded.
        unsafe { CVPixelBufferRelease(buffer) };
        if status != 0 {
            return Err(format!(
                "VideoToolbox cannot encode frame {index} (status {status})"
            ));
        }
        self.drain(out)
    }

    fn finish(&mut self, out: &mut Vec<Sample>) -> Result<(), String> {
        let status = unsafe { VTCompressionSessionCompleteFrames(self.session, CM_TIME_INVALID) };
        if status != 0 {
            return Err(format!(
                "VideoToolbox did not finish the stream (status {status})"
            ));
        }
        self.drain(out)
    }
}

impl Drop for Vt {
    fn drop(&mut self) {
        unsafe {
            if !self.session.is_null() {
                VTCompressionSessionCompleteFrames(self.session, CM_TIME_INVALID);
                VTCompressionSessionInvalidate(self.session);
                CFRelease(self.session);
                self.session = ptr::null_mut();
            }
            if !self.refcon.is_null() {
                drop(Arc::from_raw(self.refcon.cast::<Inner>()));
                self.refcon = ptr::null_mut();
            }
        }
    }
}

/// The output callback runs on a VideoToolbox thread; it only fills the shared queue.
unsafe extern "C" fn output_sample(
    refcon: *mut c_void,
    _source: *mut c_void,
    status: OSStatus,
    _flags: u32,
    sample: CMSampleBufferRef,
) {
    if refcon.is_null() {
        return;
    }
    // SAFETY: the reference is the one held by the session, which outlives this callback.
    let inner = unsafe { &*refcon.cast::<Inner>() };
    if status != 0 {
        inner.fail(format!("VideoToolbox reported status {status}"));
        return;
    }
    if sample.is_null() {
        return;
    }
    let Some(data) = sample_bytes(sample) else {
        inner.fail("VideoToolbox produced an empty frame".into());
        return;
    };
    let needs_config = inner
        .config
        .lock()
        .map(|slot| slot.is_none())
        .unwrap_or(false);
    if needs_config {
        if let Some(codec) = inner.codec {
            if let Some(config) = config_from(sample, codec) {
                if let Ok(mut slot) = inner.config.lock() {
                    *slot = Some(config);
                }
            }
        }
    }
    if let Ok(mut packets) = inner.packets.lock() {
        packets.push(Packet {
            data,
            keyframe: is_keyframe(sample),
        });
    }
}

fn cf_string(value: &str) -> CFStringRef {
    let text = CString::new(value).unwrap_or_default();
    unsafe { CFStringCreateWithCString(ptr::null(), text.as_ptr(), CF_STRING_ENCODING_UTF8) }
}

fn cf_number(value: i32) -> CFNumberRef {
    unsafe { CFNumberCreate(ptr::null(), CF_NUMBER_SINT32, (&value as *const i32).cast()) }
}

fn codec_type(codec: Codec) -> u32 {
    match codec {
        Codec::H264 => CODEC_H264,
        Codec::H265 => CODEC_HEVC,
    }
}

unsafe fn sample_bytes(sample: CMSampleBufferRef) -> Option<Vec<u8>> {
    let block = unsafe { CMSampleBufferGetDataBuffer(sample) };
    if block.is_null() {
        return None;
    }
    let mut length_at_offset = 0usize;
    let mut total_length = 0usize;
    let mut pointer: *mut c_char = ptr::null_mut();
    let status = unsafe {
        CMBlockBufferGetDataPointer(
            block,
            0,
            &mut length_at_offset,
            &mut total_length,
            &mut pointer,
        )
    };
    if status != 0 || total_length == 0 {
        return None;
    }
    if length_at_offset >= total_length && !pointer.is_null() {
        return Some(
            unsafe { std::slice::from_raw_parts(pointer.cast::<u8>(), total_length) }.to_vec(),
        );
    }
    // The block is fragmented: CoreMedia copies it into one contiguous buffer for us.
    let mut data = vec![0u8; total_length];
    let status = unsafe {
        CMBlockBufferCopyDataBytes(block, 0, total_length, data.as_mut_ptr().cast::<c_void>())
    };
    (status == 0).then_some(data)
}

/// Access units from VideoToolbox follow the AVCC layout, so only the sync flag is decided here.
unsafe fn is_keyframe(sample: CMSampleBufferRef) -> bool {
    let attachments = unsafe { CMSampleBufferGetSampleAttachmentsArray(sample, 0) };
    if attachments.is_null() || unsafe { CFArrayGetCount(attachments) } < 1 {
        return true;
    }
    let dictionary = unsafe { CFArrayGetValueAtIndex(attachments, 0) };
    if dictionary.is_null() {
        return true;
    }
    let key = cf_string("NotSync");
    let not_sync = unsafe { CFDictionaryContainsKey(dictionary, key) } != 0;
    unsafe { CFRelease(key) };
    !not_sync
}

/// Decoder configuration (avcC / hvcC) from the parameter sets VideoToolbox attached.
unsafe fn config_from(sample: CMSampleBufferRef, codec: Codec) -> Option<Vec<u8>> {
    let description = unsafe { CMSampleBufferGetFormatDescription(sample) };
    if description.is_null() {
        return None;
    }
    match codec {
        Codec::H264 => {
            let sps = unsafe { parameter_set(description, 0, true) }?;
            let pps = unsafe { parameter_set(description, 1, true) }?;
            mp4::avcc_from_parameter_sets(&sps, &pps).ok()
        }
        Codec::H265 => {
            let vps = unsafe { parameter_set(description, 0, false) }?;
            let sps = unsafe { parameter_set(description, 1, false) }?;
            let pps = unsafe { parameter_set(description, 2, false) }?;
            mp4::hvcc_from_parameter_sets(&vps, &sps, &pps).ok()
        }
    }
}

unsafe fn parameter_set(
    description: CMFormatDescriptionRef,
    index: usize,
    h264: bool,
) -> Option<Vec<u8>> {
    let (mut pointer, mut size, mut count, mut header) = (ptr::null::<u8>(), 0usize, 0usize, 0i32);
    let status = unsafe {
        if h264 {
            CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
                description,
                index,
                &mut pointer,
                &mut size,
                &mut count,
                &mut header,
            )
        } else {
            CMVideoFormatDescriptionGetHEVCParameterSetAtIndex(
                description,
                index,
                &mut pointer,
                &mut size,
                &mut count,
                &mut header,
            )
        }
    };
    if status != 0 || pointer.is_null() || size == 0 {
        return None;
    }
    Some(unsafe { std::slice::from_raw_parts(pointer, size) }.to_vec())
}

/// Probe just the selected combination, including the requested mode and target bitrate.
pub(super) fn capability(options: &VideoOptions) -> VideoCapability {
    let modes: &[Acceleration] = match options.acceleration {
        Acceleration::Auto => &[Acceleration::Hardware, Acceleration::Software],
        Acceleration::Hardware => &[Acceleration::Hardware],
        Acceleration::Software => &[Acceleration::Software],
    };
    let mut errors = Vec::new();
    for &mode in modes {
        let mut selected = *options;
        selected.acceleration = mode;
        let attempt = || -> Result<String, String> {
            let mut encoder = super::mac_encoder(&selected)?;
            let frame = vec![0u8; options.width as usize * options.height as usize * 4];
            let mut samples = Vec::new();
            encoder.push(&frame, 0, &AtomicBool::new(false), &mut samples)?;
            encoder.finish(&mut samples)?;
            if samples.is_empty() || encoder.config().is_none() {
                return Err("the encoder produced no probe frame".into());
            }
            Ok(encoder.name().to_owned())
        };
        match attempt() {
            Ok(encoder) => {
                return VideoCapability {
                    width: options.width,
                    height: options.height,
                    fps: options.fps,
                    codec: options.codec,
                    available: true,
                    bitrate: options.bitrate(),
                    reason: None,
                    encoder: Some(encoder),
                }
            }
            Err(error) => errors.push(error),
        }
    }
    VideoCapability {
        width: options.width,
        height: options.height,
        fps: options.fps,
        codec: options.codec,
        available: false,
        bitrate: options.bitrate(),
        reason: Some(errors.join("; ")),
        encoder: None,
    }
}
