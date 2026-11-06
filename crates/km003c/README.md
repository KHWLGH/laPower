**English** | [简体中文](README.zh-CN.md)

# km003c

POWER-Z KM003C / KM002C protocol support for laPower.

This workspace-only crate provides:

- Interface 0 Vendor Bulk transport for ADC and USB-PD capture;
- AES authenticated AdcQueue streaming, including 1000 samples per second;
- CDC text protocol control for PDM, PDO and charging protocol requests.
- Bounded protocol detection with structured per-protocol results, standard-scan fallback, missing-result probes and cancellation. `TriggerSession::run_with_detection` streams snapshots alongside raw replies; `run` keeps its text-only observer API.

The crate does not depend on Tauri. Device access is owned by the application runtime.

Detection reads PD PDOs independently after the other protocols, ignoring PD results embedded in list scans. Each protocol carries scoped evidence and structured voltage steps/ranges; a 5 V probe does not imply support for higher voltages. A normally terminated scan is a successful command even if some rows remain unconfirmed. PD version prefers a complete `Get_Revision` response after confirming a 5 V contract, then an explicit version reported by a completed meter scan, then the minimum version proven by PPS/EPR/SPR AVS PDOs. This best-effort query preserves the independently read PDOs and confirmed PDM settings, and leaves time for the final reset.

Detection workflow reference: [c-power POWER-Z detection](https://github.com/bruno-ntmr/c-power/blob/3cc5fc3e27bd7254be074625f82892066aefb921/c-power-cli/src/detection/device-backends.ts). The Rust implementation uses laPower's own transport, parsers and confirmed PDM settings; it does not infer proprietary certification from PD power. Tests use scripted responses, not hardware validation.
