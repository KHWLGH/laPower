// SPDX-FileCopyrightText: 2026 KHWLGH
// SPDX-License-Identifier: GPL-3.0-only
// For original project contributions; see COPYRIGHT.
//! Direct3D 11 zero copy path for the Windows encoder.
//!
//! Direct2D draws straight onto a D3D11 texture, the video processor converts it to BT.709 NV12
//! on the GPU, and Media Foundation's sample allocator hands the encoder a DXGI backed sample.
//! Nothing crosses into system memory, which is what makes a 4K export fast.
//!
//! Every step is optional: a host without a video processor, a driver that refuses NV12 output or
//! an encoder that only accepts system memory falls back to the CPU path in the parent module.

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use windows::core::Interface;
use windows::Win32::Foundation::HMODULE;
use windows::Win32::Graphics::Direct3D::{D3D_DRIVER_TYPE_HARDWARE, D3D_DRIVER_TYPE_UNKNOWN};
use windows::Win32::Graphics::Direct3D11::*;
use windows::Win32::Graphics::Dxgi::Common::*;
use windows::Win32::Graphics::Dxgi::{
    CreateDXGIFactory1, IDXGIAdapter, IDXGIAdapter1, IDXGIFactory1, DXGI_ADAPTER_FLAG_SOFTWARE,
};
use windows::Win32::Media::MediaFoundation::*;

use super::failure::{Context, Failure, Result};
use super::model::VideoOptions;

/// How long a frame may wait for the encoder to release a texture from the pool.
const POOL_TIMEOUT: Duration = Duration::from_secs(30);

/// D3D11 device plus the Media Foundation device manager that shares it with the encoder.
pub(super) struct Gpu {
    pub(super) manager: IMFDXGIDeviceManager,
    device: ID3D11Device,
    context: ID3D11DeviceContext,
}

/// How many adapters one export may try before giving up on the GPU path.
///
/// Hosts with virtual display drivers (screen recorders, emulators) commonly present several
/// adapters, and the one D3D11 picks by default is not necessarily the one with a video processor.
const MAX_ADAPTERS: usize = 4;

impl Gpu {
    /// Devices worth trying, in preference order: real adapters first, then the default device.
    ///
    /// Enumeration is deliberate rather than letting D3D11 choose: on a host with a virtual
    /// display adapter the default device may be the one that cannot encode, which used to read as
    /// "hardware encoding is broken" for every export.
    pub(super) fn candidates() -> Vec<Self> {
        let mut out = Vec::new();
        for adapter in adapters() {
            if let Some(gpu) = Self::for_adapter(Some(&adapter)) {
                out.push(gpu);
            }
        }
        if out.is_empty() {
            // No enumeration, or every adapter refused: let D3D11 pick its default device.
            if let Some(gpu) = Self::for_adapter(None) {
                out.push(gpu);
            }
        }
        out
    }

    fn for_adapter(adapter: Option<&IDXGIAdapter1>) -> Option<Self> {
        unsafe {
            let (mut device, mut context) = (None, None);
            // Passing an adapter requires D3D_DRIVER_TYPE_UNKNOWN; D3D_DRIVER_TYPE_HARDWARE is
            // only valid when the runtime chooses the device itself.
            let (adapter, driver) = match adapter {
                Some(adapter) => (
                    Some(adapter.cast::<IDXGIAdapter>().ok()?),
                    D3D_DRIVER_TYPE_UNKNOWN,
                ),
                None => (None, D3D_DRIVER_TYPE_HARDWARE),
            };
            D3D11CreateDevice(
                adapter.as_ref(),
                driver,
                HMODULE::default(),
                D3D11_CREATE_DEVICE_VIDEO_SUPPORT | D3D11_CREATE_DEVICE_BGRA_SUPPORT,
                None,
                D3D11_SDK_VERSION,
                Some(&mut device),
                None,
                Some(&mut context),
            )
            .ok()?;
            let device = device?;
            let context = context?;
            let multithread: ID3D11Multithread = context.cast().ok()?;
            // BOOL is not a Result: FALSE only means the flag was already set.
            multithread.SetMultithreadProtected(true).as_bool();
            let mut manager = None;
            let mut token = 0;
            if MFCreateDXGIDeviceManager(&mut token, &mut manager).is_err() {
                return None;
            }
            let manager = manager?;
            manager.ResetDevice(&device, token).ok()?;
            Some(Self {
                manager,
                device,
                context,
            })
        }
    }
}

/// Hardware adapters of this host, skipping software rasterisers.
fn adapters() -> Vec<IDXGIAdapter1> {
    let mut out = Vec::new();
    unsafe {
        let Ok(factory) = CreateDXGIFactory1::<IDXGIFactory1>() else {
            return out;
        };
        for index in 0..MAX_ADAPTERS as u32 {
            let Ok(adapter) = factory.EnumAdapters1(index) else {
                break;
            };
            let Ok(description) = adapter.GetDesc1() else {
                continue;
            };
            if description.Flags & DXGI_ADAPTER_FLAG_SOFTWARE.0 as u32 != 0 {
                continue;
            }
            out.push(adapter);
            if out.len() == MAX_ADAPTERS {
                break;
            }
        }
    }
    out
}

/// The GPU half of one export: the drawing texture, the colour conversion and the sample pool.
pub(super) struct GpuFrames {
    pub(super) gpu: Gpu,
    /// Direct2D renders here; it is never read by the CPU.
    pub(super) canvas: ID3D11Texture2D,
    allocator: IMFVideoSampleAllocatorEx,
    device: ID3D11VideoDevice,
    context: ID3D11VideoContext,
    enumerator: ID3D11VideoProcessorEnumerator,
    processor: ID3D11VideoProcessor,
    input: ID3D11VideoProcessorInputView,
    frame_bytes: u32,
}

impl GpuFrames {
    /// First adapter that can both draw this frame and convert it to NV12.
    ///
    /// Every candidate is tried in turn: a virtual display adapter that lacks a video processor
    /// must not decide the export, and the failure of the last one is what gets reported.
    pub(super) fn new(options: &VideoOptions) -> Result<Self> {
        let mut failure = Failure::from("this host has no Direct3D 11 device");
        for gpu in Gpu::candidates() {
            match Self::on(options, gpu) {
                Ok(frames) => return Ok(frames),
                Err(error) => failure = error,
            }
        }
        Err(failure)
    }

    fn on(options: &VideoOptions, gpu: Gpu) -> Result<Self> {
        unsafe {
            let mut canvas = None;
            gpu.device
                .CreateTexture2D(
                    &D3D11_TEXTURE2D_DESC {
                        Width: options.width,
                        Height: options.height,
                        MipLevels: 1,
                        ArraySize: 1,
                        Format: DXGI_FORMAT_B8G8R8A8_UNORM,
                        SampleDesc: DXGI_SAMPLE_DESC {
                            Count: 1,
                            Quality: 0,
                        },
                        Usage: D3D11_USAGE_DEFAULT,
                        BindFlags: (D3D11_BIND_RENDER_TARGET | D3D11_BIND_SHADER_RESOURCE).0 as u32,
                        ..Default::default()
                    },
                    None,
                    Some(&mut canvas),
                )
                .ctx("cannot allocate the GPU drawing texture")?;
            let canvas = canvas.ctx("cannot allocate the GPU drawing texture")?;
            let device: ID3D11VideoDevice = gpu.device.cast()?;
            let context: ID3D11VideoContext = gpu.context.cast()?;
            let rate = DXGI_RATIONAL {
                Numerator: options.fps,
                Denominator: 1,
            };
            let enumerator = device
                .CreateVideoProcessorEnumerator(&D3D11_VIDEO_PROCESSOR_CONTENT_DESC {
                    InputFrameFormat: D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE,
                    InputFrameRate: rate,
                    OutputFrameRate: rate,
                    InputWidth: options.width,
                    InputHeight: options.height,
                    OutputWidth: options.width,
                    OutputHeight: options.height,
                    Usage: D3D11_VIDEO_USAGE_PLAYBACK_NORMAL,
                })
                .ctx("this host has no video processor")?;
            let support = enumerator
                .CheckVideoProcessorFormat(DXGI_FORMAT_B8G8R8A8_UNORM)
                .ctx("cannot query the video processor input formats")?;
            if support & D3D11_VIDEO_PROCESSOR_FORMAT_SUPPORT_INPUT.0 as u32 == 0 {
                return Err(Failure::from("the video processor cannot read BGRA frames"));
            }
            let support = enumerator
                .CheckVideoProcessorFormat(DXGI_FORMAT_NV12)
                .ctx("cannot query the video processor output formats")?;
            if support & D3D11_VIDEO_PROCESSOR_FORMAT_SUPPORT_OUTPUT.0 as u32 == 0 {
                return Err(Failure::from(
                    "the video processor cannot write NV12 frames",
                ));
            }
            let processor = device
                .CreateVideoProcessor(&enumerator, 0)
                .ctx("cannot create the video processor")?;
            context.VideoProcessorSetStreamFrameFormat(
                &processor,
                0,
                D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE,
            );
            context.VideoProcessorSetStreamAutoProcessingMode(&processor, 0, false);
            let colour: ID3D11VideoContext1 = context.cast()?;
            colour.VideoProcessorSetStreamColorSpace1(
                &processor,
                0,
                DXGI_COLOR_SPACE_RGB_FULL_G22_NONE_P709,
            );
            colour.VideoProcessorSetOutputColorSpace1(
                &processor,
                DXGI_COLOR_SPACE_YCBCR_STUDIO_G22_LEFT_P709,
            );
            let mut input = None;
            device
                .CreateVideoProcessorInputView(
                    &canvas,
                    &enumerator,
                    &D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC {
                        ViewDimension: D3D11_VPIV_DIMENSION_TEXTURE2D,
                        ..Default::default()
                    },
                    Some(&mut input),
                )
                .ctx("cannot create the video processor input")?;
            let input = input.ctx("cannot create the video processor input")?;
            let mut raw = std::ptr::null_mut();
            MFCreateVideoSampleAllocatorEx(&IMFVideoSampleAllocatorEx::IID, &mut raw)
                .ctx("cannot create the GPU frame pool")?;
            if raw.is_null() {
                return Err(Failure::from("cannot create the GPU frame pool"));
            }
            let allocator = IMFVideoSampleAllocatorEx::from_raw(raw);
            allocator.SetDirectXManager(&gpu.manager)?;
            // The manager keeps its own reference to the device; dropping the token afterwards
            // would leave the encoder holding a device the manager no longer knows about.
            let mut attributes = None;
            MFCreateAttributes(&mut attributes, 2)?;
            let attributes = attributes.ctx("cannot describe the GPU frame pool")?;
            attributes.SetUINT32(&MF_SA_D3D11_BINDFLAGS, D3D11_BIND_RENDER_TARGET.0 as u32)?;
            attributes.SetUINT32(&MF_SA_D3D11_USAGE, D3D11_USAGE_DEFAULT.0 as u32)?;
            allocator.InitializeSampleAllocatorEx(
                3,
                8,
                &attributes,
                &super::windows::nv12_type(options)?,
            )?;
            Ok(Self {
                gpu,
                canvas,
                allocator,
                device,
                context,
                enumerator,
                processor,
                input,
                frame_bytes: options.width * options.height * 3 / 2,
            })
        }
    }

    /// Convert the drawing texture into one NV12 sample owned by the encoder's pool.
    pub(super) fn sample(&self, cancel: &AtomicBool) -> Result<IMFSample> {
        let start = Instant::now();
        unsafe {
            // The allocator hands a texture back only after the encoder releases its sample.
            let sample = loop {
                if cancel.load(Ordering::Acquire) {
                    return Err(Failure::from("video encoding was cancelled"));
                }
                match self.allocator.AllocateSample() {
                    Ok(sample) => break sample,
                    Err(error) if error.code() == MF_E_SAMPLEALLOCATOR_EMPTY => {
                        if start.elapsed() > POOL_TIMEOUT {
                            return Err(Failure::from(
                                "the GPU encoder did not release a frame buffer for 30 seconds",
                            ));
                        }
                        std::thread::sleep(Duration::from_millis(1));
                    }
                    Err(error) => return Err(Failure::from(error)),
                }
            };
            let buffer: IMFDXGIBuffer = sample.GetBufferByIndex(0)?.cast()?;
            let mut raw = std::ptr::null_mut();
            buffer.GetResource(&ID3D11Texture2D::IID, &mut raw)?;
            if raw.is_null() {
                return Err(Failure::from("the GPU frame has no texture"));
            }
            let texture = ID3D11Texture2D::from_raw(raw);
            let mut output = None;
            self.device.CreateVideoProcessorOutputView(
                &texture,
                &self.enumerator,
                &D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC {
                    ViewDimension: D3D11_VPOV_DIMENSION_TEXTURE2DARRAY,
                    Anonymous: D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC_0 {
                        Texture2DArray: D3D11_TEX2D_ARRAY_VPOV {
                            MipSlice: 0,
                            FirstArraySlice: buffer.GetSubresourceIndex()?,
                            ArraySize: 1,
                        },
                    },
                },
                Some(&mut output),
            )?;
            let output = output.ctx("cannot create the video processor output")?;
            let mut stream = D3D11_VIDEO_PROCESSOR_STREAM {
                Enable: true.into(),
                pInputSurface: std::mem::ManuallyDrop::new(Some(self.input.clone())),
                ..Default::default()
            };
            let result = self.context.VideoProcessorBlt(
                &self.processor,
                &output,
                0,
                std::slice::from_ref(&stream),
            );
            std::mem::ManuallyDrop::drop(&mut stream.pInputSurface);
            result.ctx("the GPU colour conversion failed")?;
            self.gpu.context.Flush();
            sample
                .GetBufferByIndex(0)?
                .SetCurrentLength(self.frame_bytes)?;
            Ok(sample)
        }
    }
}
