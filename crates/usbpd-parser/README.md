**English** | [简体中文](README.zh-CN.md)

# usbpd-parser

Parse USB Power Delivery messages into an inspectable field tree.

A Rust port of the [`usbpdparser`](https://pypi.org/project/usbpdparser/) Python
package. No USB dependency — feed it bytes from a meter, a capture file, or a logic
analyser.

```rust
use usbpd_parser::{ParseOptions, Parser, Sop};

let mut parser = Parser::new();
let msg = parser.parse(
    &[0xA1, 0x11, 0x2C, 0x91, 0x01, 0x08],
    ParseOptions { sop: Sop::Sop, ..Default::default() },
);

let pdo = msg.get("Data Objects").unwrap().get("PDO 1").unwrap();
assert_eq!(pdo.quick_pdo(), Some("F 5.0V@3.0A"));
assert_eq!(pdo.get("Voltage").unwrap().value().as_str(), Some("5.0V"));
```

Covers the Message Header and Extended Message Header, every PDO and RDO shape
(fixed, battery, variable, PPS, SPR/EPR AVS, and their Sink mirrors), the VDM header
and Discover Identity VDOs, every Data Message body, and every Extended Message body
including reassembly of the chunked ones.

`Parser` carries the conversation state that makes context-dependent messages
decodable; see the crate docs. `Parser::parse` never fails — an undecodable message
still yields a tree, with the bytes under `Error Data`. `Parser::try_parse` reports
the `ParseError` instead.

## Features

- `serde` *(default)* — `Serialize` for `Metadata` and friends.
- `vendor-ids` *(default)* — the USB-IF vendor table behind `vendor_name`.

## Example

```console
$ cargo run --example decode -- A1612C91010E4121A4C1
```

See the [workspace README](../../README.md) for the full picture, including how this
differs from the Python original.

## Copyright and license

Copyright (C) 2026 KHWLGH

This notice covers only KHWLGH's own contributions to this library, its tests, examples and documentation, under LGPL-3.0-or-later. Other authors retain their rights; Git authorship does not establish an assignment.

The original Python package [usbpdparser 1.1.6](https://github.com/JohnScotttt/USB_PD_Parser_API_Py) declares `Copyright (c) 2025 JohnScotttt` and LGPL-3.0-or-later. The Rust sources came through the retired WITRN-API-RS project (last recorded import `30c4bdb`); that object and a public repository copy are unavailable, so its complete notice history remains unverified. The vendor ID table cites upstream `tools/vendor_ids_dict.py`; no separate table notice or independent source-data license has been established. These gaps do not establish KHWLGH ownership or an additional license grant.

See the root [`COPYRIGHT`](../../COPYRIGHT) for scope and source evidence. Read the local full [`LGPLv3`](../../LICENSE.LGPL-3.0) together with [`GPLv3`](../../LICENSE); the later-version option comes from the library declaration. The software comes without warranty and may be modified and redistributed under the applicable license conditions.
