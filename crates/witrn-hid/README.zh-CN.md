[English](README.md) | **简体中文**

# witrn-hid

读取并解码 WITRN USB 功率计的 HID 数据流。

这是 Python 包 [`witrnhid`](https://github.com/JohnScotttt/WITRN_HID_API) 的 Rust 移植。WITRN 仪表（K2、U3、C5 等）发送两类 64 字节 HID 报告：测量样本和捕获的 USB-PD 报文。本库打开设备、读取报告，并将两种报告解析为 [`usbpd-parser`](../usbpd-parser/README.zh-CN.md) 定义的字段树。

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

测量报告包含 `Ah`、`Wh`、`Rectime`、`Runtime`、`D+`、`D-`、`Temperature`、`VBus`、`Current`、`Group`、`CC1` 和 `CC2`。

PD 报告由内置 `Parser` 解码，自动保留 `Source_Capabilities`／`Request` 对应关系和分块扩展报文的上下文，无需调用方额外管理。回看捕获等需要自有消息历史的场景，可以显式传入上下文，不改变设备内部状态。

## 示例

```console
$ cargo run --example monitor -- --list
$ cargo run --example monitor
```

完整项目说明及与 Python 原版的区别见[项目 README](../../README.zh-CN.md)。

## 版权与许可

Copyright (C) 2026 KHWLGH

上述版权行仅覆盖 KHWLGH 对本库、测试、例子与文档的自有贡献，采用 LGPL-3.0-or-later。其他作者保留其权利，不因 Git 作者记录推定转让。

原始 Python 包 [witrnhid 1.1.5](https://github.com/JohnScotttt/WITRN_HID_API) 声明 `Copyright (c) 2025 JohnScotttt`、LGPL-3.0-or-later。当前 Rust 源经退役 WITRN-API-RS 项目导入，最后记录为 `30c4bdb`；该对象与公开仓库副本不可取得，完整历史声明尚无法核实，不据此推断其他作者、转让或许可。

范围与来源证据见根目录 [`COPYRIGHT`](../../COPYRIGHT)；本地完整 [`LGPLv3`](../../LICENSE.LGPL-3.0) 须与 [`GPLv3`](../../LICENSE) 一起阅读，“或更新版本”选项由库的许可声明授予。软件不提供担保，可按适用许可的条件修改和再分发。
