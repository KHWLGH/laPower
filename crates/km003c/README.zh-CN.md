[English](README.md) | **简体中文**

# km003c

为 laPower 提供 POWER-Z KM003C／KM002C 协议支持。

该库仅在工作区使用，提供：

- Interface 0 Vendor Bulk 传输，用于 ADC 与 USB-PD 采集；
- 经 AES 认证的 AdcQueue 数据流，包括每秒 1000 次采样；
- CDC 文本协议控制，用于 PDM、PDO 及充电协议请求。

本库不依赖 Tauri，设备访问由应用运行时拥有。
