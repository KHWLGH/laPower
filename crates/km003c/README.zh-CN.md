[English](README.md) | **简体中文**

# km003c

为 laPower 提供 POWER-Z KM003C／KM002C 协议支持。

该库仅在工作区使用，提供：

- Interface 0 Vendor Bulk 传输，用于 ADC 与 USB-PD 采集；
- 经 AES 认证的 AdcQueue 数据流，包括每秒 1000 次采样；
- CDC 文本协议控制，用于 PDM、PDO 及充电协议请求。
- 有总时限的协议检测，包含逐协议状态、常规扫描回退、缺失结果补探与取消；`TriggerSession::run_with_detection` 同时提供结构化快照和原始回复，`run` 保留原有文本回调接口。

本库不依赖 Tauri，设备访问由应用运行时拥有。

MTK PE 1.0 与 2.0 在检测结果和文本摘要中分别使用 `pe1`／`pe2` 身份。固件空字段保持未确认，过程日志保留重复出现的结果。

检测在其他协议结束后独立读取 PD PDO，忽略列表扫描附带的 PD 结果。各协议保留独立依据与结构化电压档位／范围；单项 5 V 验证不代表支持更高电压。扫描正常结束即为命令成功，即使部分协议仍未确认。PD 版本优先使用进入 PD 并独立读取有效 PDO 后的完整 `Get_Revision` 响应，其次采用完整仪表扫描明确报告的版本，最后才使用 PPS/EPR/SPR AVS PDO 所能证明的最低版本。此尽力查询沿用当前 PD 会话，不额外请求 5 V，保留独立读取的 PDO 和已确认 PDM 设置，并为最终复位预留时间。

检测流程参考 [c-power POWER-Z 检测](https://github.com/bruno-ntmr/c-power/blob/3cc5fc3e27bd7254be074625f82892066aefb921/c-power-cli/src/detection/device-backends.ts)，Rust 实现沿用 laPower 的传输、解析和已确认 PDM 参数，不根据 PD 功率推断私有认证。测试使用脚本回复，不代表硬件验证。

能力项区分 PD 与 UFCS 并保留物理编号。PdmOpen 接受可选配置，返回结果分别表达用户选择与当前已确认配置。VoltageCache 接收调用方唯一采集线程提供的带时间戳样本，应答确认不能代替实测。结束和取消后的复位在有时限的恢复阶段验证 5 V，并继续服从会话关闭信号。Raw 命令使旧模式失效，十六进制非法输入直接拒绝，不静默改变字节。固件布局由 KM003C V2.0.6 实机内存样本确认，未知布局保持未知。

## 版权与许可

Copyright (C) 2026 KHWLGH

上述版权行仅覆盖 KHWLGH 对本库、测试、例子与文档的自有贡献，采用 LGPL-3.0-or-later。其他作者保留其权利，不因 Git 作者记录推定转让。上述公开协议研究与检测流程参考保留各自声明与权利；引用不代表对上游代码、设备数据或协议事实主张所有权。

范围与来源声明见根目录 [`COPYRIGHT`](../../COPYRIGHT)；本地完整 [`LGPLv3`](../../LICENSE.LGPL-3.0) 须与 [`GPLv3`](../../LICENSE) 一起阅读，“或更新版本”选项由库的许可声明授予。软件不提供担保，可按适用许可的条件修改和再分发。
