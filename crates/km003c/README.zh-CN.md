[English](README.md) | **简体中文**

# km003c

为 laPower 提供 POWER-Z KM003C／KM002C 协议支持。

该库仅在工作区使用，提供：

- Interface 0 Vendor Bulk 传输，用于 ADC 与 USB-PD 采集；
- 经 AES 认证的 AdcQueue 数据流，包括每秒 1000 次采样；
- CDC 文本协议控制，用于 PDM、PDO 及充电协议请求。
- 有总时限的协议检测，包含逐协议状态、常规扫描回退、缺失结果补探与取消；`TriggerSession::run_with_detection` 同时提供结构化快照和原始回复，`run` 保留原有文本回调接口。

本库不依赖 Tauri，设备访问由应用运行时拥有。

检测在其他协议结束后独立读取 PD PDO，忽略列表扫描附带的 PD 结果。各协议保留独立依据与结构化电压档位／范围；单项 5 V 验证不代表支持更高电压。

检测流程参考 [c-power POWER-Z 检测](https://github.com/bruno-ntmr/c-power/blob/3cc5fc3e27bd7254be074625f82892066aefb921/c-power-cli/src/detection/device-backends.ts)，Rust 实现沿用 laPower 的传输、解析和已确认 PDM 参数，不根据 PD 功率推断私有认证。测试使用脚本回复，不代表硬件验证。
