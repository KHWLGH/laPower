**English** | [简体中文](README.zh-CN.md)

# km003c

POWER-Z KM003C / KM002C protocol support for laPower.

This workspace-only crate provides:

- Interface 0 Vendor Bulk transport for ADC and USB-PD capture;
- AES authenticated AdcQueue streaming, including 1000 samples per second;
- CDC text protocol control for PDM, PDO and charging protocol requests.
- Bounded protocol detection with structured per-protocol results, standard-scan fallback, missing-result probes and cancellation. `TriggerSession::run_with_detection` streams snapshots alongside raw replies; `run` keeps its text-only observer API.

The crate does not depend on Tauri. Device access is owned by the application runtime.

MTK PE 1.0 and 2.0 use distinct `pe1` / `pe2` identities in both detection results and text summaries. Empty firmware fields remain unconfirmed; chronological logs preserve repeated observations.

Detection reads PD PDOs independently after the other protocols, ignoring PD results embedded in list scans. Each protocol carries scoped evidence and structured voltage steps/ranges; a 5 V probe does not imply support for higher voltages. A normally terminated scan is a successful command even if some rows remain unconfirmed. PD version prefers a complete `Get_Revision` response after PD entry and independent discovery of valid PDOs, then an explicit version reported by a completed meter scan, then the minimum version proven by PPS/EPR/SPR AVS PDOs. This best-effort query uses the current PD session without an extra 5 V request, preserves the independently read PDOs and confirmed PDM settings, and leaves time for the final reset.

Detection workflow reference: [c-power POWER-Z detection](https://github.com/bruno-ntmr/c-power/blob/3cc5fc3e27bd7254be074625f82892066aefb921/c-power-cli/src/detection/device-backends.ts). The Rust implementation uses laPower's own transport, parsers and confirmed PDM settings; it does not infer proprietary certification from PD power. Tests use scripted responses, not hardware validation.

Capabilities distinguish PD and UFCS and retain physical positions. PdmOpen accepts optional settings; outcomes expose confirmed configuration separately from user selections. VoltageCache accepts timestamped samples from the caller’s sole acquisition reader; acknowledgements never substitute for measurements. Completion/cancellation resets verify 5 V within a bounded recovery period while still obeying session shutdown. Raw commands invalidate mode state, and malformed hex is rejected without silently changing bytes. Firmware record parsing is based on a captured KM003C V2.0.6 memory record; unknown layouts remain unknown.

## Copyright and license

Copyright (C) 2026 KHWLGH

This notice covers only KHWLGH's own contributions to this library, its tests, examples and documentation, under LGPL-3.0-or-later. Other authors retain their rights; Git authorship does not establish an assignment. The public protocol research and workflow reference credited above retain their own notices and rights; citing them does not claim ownership of upstream code, device data or protocol facts.

See the root [`COPYRIGHT`](../../COPYRIGHT) for scope and source declarations. Read the local full [`LGPLv3`](../../LICENSE.LGPL-3.0) together with [`GPLv3`](../../LICENSE); the later-version option comes from the library declaration. The software comes without warranty and may be modified and redistributed under the applicable license conditions.
