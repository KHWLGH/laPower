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

Python 原始实现由 [JohnScotttt](https://github.com/JohnScotttt) 编写。许可证：LGPL-3.0-or-later。
