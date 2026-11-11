**English** | [简体中文](README.zh-CN.md)

# witrn-hid

Read and decode the HID stream from a WITRN USB power meter.

A Rust port of the [`witrnhid`](https://github.com/JohnScotttt/WITRN_HID_API) Python
package. WITRN meters (K2, U3, C5 …) stream 64-byte HID reports of two kinds:
measurement samples, and captured USB-PD traffic. This crate opens the device, reads
reports, and unpacks both into the field tree
[`usbpd-parser`](../usbpd-parser) defines.

```rust
use witrn_hid::{ReportKind, WitrnDev};

let mut dev = WitrnDev::new();
dev.open()?;                                   // K2; or open_vid_pid / open_path

loop {
    let report = dev.read_data()?;
    match ReportKind::of(report) {
        Some(ReportKind::General) => {
            let (at, msg) = dev.general_unpack(None)?;
            println!("{at}  {}  {}",
                msg.get("VBus").unwrap().value(),
                msg.get("Current").unwrap().value());
        }
        Some(ReportKind::Pd) => {
            let (at, msg) = dev.pd_unpack(None, None, None, None)?;
            println!("{at}  {}", usbpd_parser::to_plain(&usbpd_parser::render(&msg, 1)));
        }
        Some(_) | None => {}
    }
}
```

A general report carries `Ah`, `Wh`, `Rectime`, `Runtime`, `D+`, `D-`,
`Temperature`, `VBus`, `Current`, `Group`, `CC1` and `CC2`.

PD reports are decoded by an embedded `Parser`, so `Source_Capabilities`/`Request`
pairs and chunked extended messages resolve across the stream with no bookkeeping on
your side. If you keep your own message history — for scrubbing back through a
capture — pass the context explicitly and the device's own state is left alone.

## Example

```console
$ cargo run --example monitor -- --list
$ cargo run --example monitor
```

See the [workspace README](../../README.md) for the full picture, including how this
differs from the Python original.

## Copyright and license

Copyright (C) 2026 KHWLGH

This notice covers only KHWLGH's own contributions to this library, its tests, examples and documentation, under LGPL-3.0-or-later. Other authors retain their rights; Git authorship does not establish an assignment.

The original Python package [witrnhid 1.1.5](https://github.com/JohnScotttt/WITRN_HID_API) declares `Copyright (c) 2025 JohnScotttt` and LGPL-3.0-or-later. The Rust sources came through the retired WITRN-API-RS project (last recorded import `30c4bdb`); that object and a public repository copy are unavailable, so its complete notice history remains unverified. No additional author, assignment or license is inferred.

See the root [`COPYRIGHT`](../../COPYRIGHT) for scope and source evidence. Read the local full [`LGPLv3`](../../LICENSE.LGPL-3.0) together with [`GPLv3`](../../LICENSE); the later-version option comes from the library declaration. The software comes without warranty and may be modified and redistributed under the applicable license conditions.
