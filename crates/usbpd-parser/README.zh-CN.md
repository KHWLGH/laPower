[English](README.md) | **简体中文**

# usbpd-parser

将 USB Power Delivery 报文解析为可检查的字段树。

这是 Python 包 [`usbpdparser`](https://pypi.org/project/usbpdparser/) 的 Rust 移植，不依赖 USB。可以输入来自仪表、捕获文件或逻辑分析仪的字节。

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

覆盖 Message Header、Extended Message Header、各种 PDO 与 RDO（固定、Battery、Variable、PPS、SPR/EPR AVS 及相应 Sink 形式）、VDM Header、Discover Identity VDO、所有 Data Message 与 Extended Message 正文，包括分块扩展报文的重组。

`Parser` 保存对话上下文，用于解码依赖此前消息的字段，详见 crate 文档。`Parser::parse` 不返回错误：无法解码时仍返回一棵树，将原始字节放入 `Error Data`。`Parser::try_parse` 则返回 `ParseError`。

## Features

- `serde`（默认开启）：为 `Metadata` 等类型提供 `Serialize`。
- `vendor-ids`（默认开启）：提供 `vendor_name` 使用的 USB-IF 厂商表。

## 示例

```console
$ cargo run --example decode -- A1612C91010E4121A4C1
```

完整项目说明及与 Python 原版的区别见[项目 README](../../README.zh-CN.md)。

## 版权与许可

Copyright (C) 2026 KHWLGH

上述版权行仅覆盖 KHWLGH 对本库、测试、例子与文档的自有贡献，采用 LGPL-3.0-or-later。其他作者保留其权利，不因 Git 作者记录推定转让。

原始 Python 包 [usbpdparser 1.1.6](https://github.com/JohnScotttt/USB_PD_Parser_API_Py) 声明 `Copyright (c) 2025 JohnScotttt`、LGPL-3.0-or-later。当前 Rust 源经退役 WITRN-API-RS 项目导入，最后记录为 `30c4bdb`；该对象与公开仓库副本不可取得，完整历史声明尚无法核实。厂商 ID 表注明来自上游 `tools/vendor_ids_dict.py`，未确认独立表声明或来源数据许可；这些证据缺口不构成 KHWLGH 所有权或额外许可授予。

范围与来源证据见根目录 [`COPYRIGHT`](../../COPYRIGHT)；本地完整 [`LGPLv3`](../../LICENSE.LGPL-3.0) 须与 [`GPLv3`](../../LICENSE) 一起阅读，“或更新版本”选项由库的许可声明授予。软件不提供担保，可按适用许可的条件修改和再分发。
