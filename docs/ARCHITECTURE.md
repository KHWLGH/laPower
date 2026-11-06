[English](en/ARCHITECTURE.md) | **简体中文**

← 返回 [README](../README.zh-CN.md)

# 技术架构

本文描述 laPower 的内部结构。使用说明见 [使用指南](USAGE.md)，构建方式见 [开发与构建](DEVELOPMENT.md)。

- [仓库布局](#仓库布局)
- [后端](#后端)
- [协议库](#协议库)
- [前端](#前端)
- [数据流](#数据流)
- [HID 报文布局](#hid-报文布局)
- [测试](#测试)
- [安全边界](#安全边界)

## 仓库布局

Cargo workspace，四个成员 + 一个原生 JavaScript 前端源码目录；发布构建由 esbuild 生成前端产物。

```
laPower/
├── src-tauri/            Tauri v2 应用（后端）
│   ├── src/lib.rs        应用状态、Tauri 命令、HID 读线程与 IPC 发射线程
│   ├── src/pd_capture.rs USB-PD 捕获会话（seq / generation / 按需解码）
│   ├── src/usb_port.rs   分平台 USB 拓扑解析
│   ├── src/updates.rs    手动 GitHub 更新检查与受限浏览器跳转
│   ├── capabilities/     Tauri ACL 能力声明
│   └── tauri.conf.json   窗口、CSP、打包配置
├── crates/
│   ├── usbpd-parser/     USB-PD 报文解码库
│   ├── km003c/            POWER-Z Bulk 协议、AdcQueue 与 CDC 控制
│   └── witrn-hid/        WITRN HID 设备封装
├── src/                  前端源文件（原生 ES Modules）
├── out/                  构建后的 frontendDist（不入库）
├── tools/showcase/       虚拟设备与截图开发工具（不随应用发货）
├── test/                 前端单元测试（node --test）
├── temperature-example/  外部温度服务 Python 示例
└── docs/                 本文档目录
```

工作区在 `Cargo.toml` 里统一了 `version`、`edition = 2021`、`rust-version = 1.85` 与公共依赖（`serde`、`serde_json`、`hidapi 2.6`、`chrono 0.4`）。

## 后端

### `src-tauri/src/lib.rs`

承载应用状态、设备命令与各模块 Tauri 命令的注册。共享状态的设计原则是**只在必要处加锁**：

- `sample_rate: Arc<AtomicU64>` —— HID 读循环每次迭代都要读采样率，用原子量避免每帧取一次锁。
- 其余共享状态用 `Arc<Mutex<...>>`。

### 线程模型

每个设备连接持有读线程与 IPC 发射线程；POWER-Z 另外持有一个 CDC 协议控制线程：

```
HID 读线程 ──── channel ────> IPC 发射线程 ──── emit ────> WebView
 只解码，不 emit                合并 / 转发
                         ↘ POWER-Z CDC 控制线程
```

- **采集读线程** —— WITRN 阻塞读 HID 报告，读到后再非阻塞排空主机已排队的报告；POWER-Z 读取 Vendor Bulk / AdcQueue；解码后按采样间隔的节拍网格分窗，每个窗口求平均（电压、电流、功率、D+ / D−；时间、CC、温度取窗口内最后一帧）成一个点，写入容量 4096 的有界通道。PD 事件在通道满时进入最多 256 条的 pending，完整报文仍保留在后端日志。测量样本的未确认量达到 8192 时明确停止采集并报错。
- **IPC 发射线程** —— 测量与 PD 分别发为 `device-data-batch` / `pd-data-batch`。测量按最多 64 点或 `clamp(4 × 采样间隔, 8 ms, 50 ms)` 合批，保留每点的序号、录制段与时间戳；前端消费后通过 ACK 确认。采集停止时先排空残留，再发末包回执与断开事件。

因为采集能否继续取决于前端 ACK，窗口不可见时前端也必须照常运行。macOS 上两件事会破坏这一点，因此分别处理：WKWebView 默认挂起不可见的页面，主窗口配置 `backgroundThrottling: "disabled"`（macOS 14+）；App Nap 会合并整个进程的定时器并降低线程优先级，读线程存活期间持有 `NSProcessInfo` activity（`src-tauri/src/app_nap.rs`）退出 App Nap，并带 `LatencyCritical`：只退出 App Nap 时，最小化窗口下读线程仍偶尔迟醒（实测最大 36 ms）。迟醒无法完全避免（系统负载高时窗口可见也会出现，70 分钟实测最长 89.9 ms），所以 WITRN 读取源（`HidSource`）在每次读到报告后用非阻塞读排空 hidapi 队列，再由 `acquire::stamp_drained` 把这批样本的时间戳均匀回推到上一个样本与当前时刻之间（相邻不超过设备节拍 10 ms，最新一个仍是接收时刻）。否则积压报告会全部打上同一个接收时刻、落进同一个 10 ms 选择窗口，被同一个选择窗口合并成一个点。PD 报告按事件到达，不参与回推。读线程收到非零的录制段（`set_recording_segment`）时换成同时阻止系统空闲睡眠的 activity，收到 0（暂停、停止、清空）时换回只退出 App Nap 的那个；先开始新的再结束旧的，切换时不留空档。屏幕熄灭、合盖和手动睡眠不受影响。Windows 的 WebView2 最小化时仍在运行，不受这两项影响。

录制段和采样率边界先由 `HidSource::barrier` 非阻塞排空旧队列，旧报告仍按旧段／旧采样率处理；队列超过有界排空容量时明确停止，而不是把残留报告带入新段。窗口封口后通过 `seal_boundary` 将下一批回推时间戳限制在屏障之后。

`BackgroundTask::stop()` 先置停止标志再 `join`，且**顺序固定为先生产者后消费者** —— 反过来会让读线程写入一个没人消费的通道。

`shutdown` 命令标注 `#[tauri::command(async)]`，这样它不会在主线程上 join 那些正在 `emit` 的工作线程（否则互相等待会死锁）。停完线程后 `destroy` 主窗口，而不是 `close` —— Tauri v2 的 `close()` 会重新派发 `close-requested`，造成退出回环。

退出前必须先「消费完并 ACK 末包」，这条校验只在 `shutdown` 上；一旦流进入终态（`seq` 空洞、背压超限、屏障超时），`fail()` 已经把生产端 drain 停掉，屏障保护的样本不可能再出现，此时继续坚持校验只会让**断开 / 重连 / 退出永久全部失败**。前端因此改走 `abandon_device_stream`：它只接受「已停止 + 线程已 join + 已有末包回执 + 同 generation」的会话并退休该槽位，**且不写 `consumed`**，所以空洞依旧算未消费。`shutdown` 的谓词一字未改，放宽只发生在这条显式路径上。

### Tauri 命令

| 命令 | 作用 |
| --- | --- |
| `enumerate_devices` | 合并 WITRN HID 与 POWER-Z Vendor Bulk 设备枚举 |
| `connect_device_by_path` | 按枚举返回的设备路径连接 WITRN HID 或 POWER-Z Bulk（前端实际使用的入口） |
| `disconnect_device` | 断开并停止该连接的后台线程 |
| `get_current_device_info` | 返回当前连接的设备信息 |
| `set_sample_rate` | 设置采样间隔，接受 1 – 60000 ms；按设备下限钳制 |
| `set_pd_capture_enabled` | 开关 PD 报文采集 |
| `pd_log_clear` | 清空 PD 日志，返回新的 generation |
| `pd_log_after` | 增量拉取 `seq` 大于给定值的报文 |
| `pd_log_replace` | 用导入的报文替换日志，并盖上新 generation |
| `decode_pd_at` | 按 `seq` 单帧解码，O(1)，用于点击某行时才展开详情 |
| `drain_device_stream` | 停止该连接的后台线程并取回末包回执（幂等，可重复调用） |
| `ack_device_stream` | 确认同 generation 中已消费的样本序号 |
| `set_recording_segment` | 在采集源建立录制段边界，同步 PD 跟随状态 |
| `abandon_device_stream` | 退休一个终态会话，让断开 / 重连 / 退出重新可达；不改写 `consumed` |
| `connect_temp_service` / `disconnect_temp_service` | 外部 TCP 温度源 |
| `check_for_updates` | 仅手动请求 GitHub 正式 Release，10 秒超时，SemVer 比较；错误返回稳定错误码 |
| `open_project_page` | 用系统浏览器打开固定仓库首页或经校验的该仓库发布页 |
| `shutdown` | 停止全部后台线程后销毁主窗口 |
| `km003c_trigger` / `km003c_cancel_trigger` | 执行或取消 POWER-Z 协议控制命令 |
| `video_export_capabilities` | 返回宿主实际可用的分辨率／帧率／编码组合；进程内只探测一次 |
| `video_export_pick` | 用原生保存对话框选择目标位置并返回一次性 ticket；路径不经过前端 |
| `video_export_start` | 校验冻结载荷并在后台线程开始编码，返回任务状态 |
| `video_export_status` | 按 id 返回任务状态、进度与失败信息 |
| `video_export_current` | 返回当前任务，供重开的对话框接回进度 |
| `video_export_cancel` | 请求取消当前任务；编码线程退出前任务仍占用唯一的编码槽 |

### `src-tauri/src/pd_capture.rs`

PD 日志是一个只追加的 `Vec`，**`seq` 就是下标**，因此 `decode_pd_at` 是 O(1) 查找而不是线性扫描。原始帧被保留下来，详情面板要看哪一帧才解码哪一帧，避免为所有报文预先构建解码树。

- `generation` —— 每次清空或导入替换都递增。前端拿到的事件带着 generation，因此**导入的历史捕获不会和实时流串号**。
- 断开连接产生的分隔行只出现在返回的事件流里，不占用 `seq`。
- `PD_LOG_HARD_CAP = 1_000_000` 是硬上限；前端 `PD_SOFT_CAP = 500_000` 时弹出提示。

### `src-tauri/src/usb_port.rs`

把 HID 路径反解成 USB 拓扑端口（如 `4-4`），用于在设备名里区分插在不同口上的同型号仪表。三套实现：

- **Windows** —— `CM_Get_DevNode_PropertyW` + `DEVPKEY_Device_LocationPaths`，解析 `PCIROOT(0)#PCI(1400)#USBROOT(0)#USB(4)#USB(4)` 形式的字符串。
- **Linux** —— 取 `hidraw*` 名，`canonicalize` `/sys/class/hidraw/<name>/device`，逐级向上读 `devpath` 拼出端口路径。纯只读 sysfs 访问，不需要特殊权限（与打开 `/dev/hidrawN` 不同）。
- **macOS** —— 非独占方式打开设备读 `get_location_id`。

其他平台返回 `None`，设备名退化为不带端口后缀的形式。

> 维简硬件的 USB 序列号是**生产批次日期**而非单机编号，同批次的两台仪表序列号相同。枚举时先按 USB 端口分组，再叠加序列号，以便标题栏区分插在不同口上的同型号仪表。

### `src-tauri/src/video_export.rs`

报告入口统一为“导出报告”，图片和视频复用冻结快照、单任务状态、原生目标 ticket、暂存文件与成功后提交机制。内部 IPC 名称保留 `video_export_*` 以兼容现有调用。`VideoOptions` 增加 `reportType`（image/video）、`imageLayout`（widescreen/long）及独立的 `showMarkers`、`showMarkerDetails`；缺字段的旧后端载荷按 video、widescreen、两项开启解释，前端首次使用默认 image。设置仍保存在原 `videoExport` 块中，不丢弃已有视频选项。PNG 绕过视频能力探测与编码器，Windows 用 Direct2D/WIC，其他平台用 tiny-skia 保存无损 PNG。

静态报告展示整段统计、完整曲线与总时长，不绘制播放光标、动态读数和进度条。平均电压按有效时间加权，统计与曲线沿用原始数据及缺测语义；两个打点开关分别控制曲线标记和下方详情。视频及 16:9 图片最多含前八个打点，长图保留全部打点并按详情行扩展高度。后端限制载荷数量、图片高度和总像素，超限显式失败，取消或失败不覆盖原目标。

报告视频导出是宿主侧的单槽任务。`video_export_capability` 按用户当前选中的那一组选项用真实的一帧试编码探测，结果按组合缓存在进程内——一次打开对话框只探测一个组合，而不是逐个试完全部 24 个；`video_export_pick` 打开原生保存对话框并返回一次性 ticket，路径留在后端，前端无法指定任意目标；`video_export_start` 校验冻结载荷后启动 `lapower-video` 线程；`video_export_status` 与 `video_export_current` 分别服务对话框每 500 ms 一次的进度轮询和重开后的接回；`video_export_cancel` 只置位取消标志，由编码循环逐帧检查。关闭对话框或切换工作区不会中止编码；同一时刻只有一个任务，取消请求也要等编码线程真正退出才释放槽位。退出时 `shutdown` 取消当前任务并最多等待两秒回收编码线程；超时只记日志，残留的暂存文件带进程号，便于识别。

前后端投影上限统一为 256 桶 × 10 点（首尾与四通道极值），共 2560 点。能力探测完成后才允许提交；对话框关闭后仍每 500 ms 跟踪活动任务并只通知一次终态。查询使用任务版本和请求序号忽略过期结果，临时失败保留任务重试；错误展示保留原始诊断。

采样只存在于前端的列式存储里，后端没有可按时间查询的记录库，因此 `src/video-export.js` 在用户确认时冻结列快照，`src/video-projection.js`（纯函数）一次投影出自包含的载荷：汇总统计、256 个时间桶的曲线投影（每桶保留首样本、末样本和各通道的最小／最大值，短记录直接使用原始点）、每个视频帧的一组通道读数（最后一帧对应最后一个样本）以及最多 8 个打点。`src/video-export-options.js` 是分辨率、帧率、编码、容器白名单与帧数公式的唯一来源，`src/video-palette.js` 带出浅深两套已解析的颜色。载荷交给后端后不再读取任何记录数据，编码期间继续记录也不会改变这份报告。

`src-tauri/src/video_export.rs` 及其子模块只负责渲染与封装。`model.rs` 校验载荷结构与长度。`scene.rs` 是唯一的排版实现（逻辑画布固定 1920 × 1080，按 `width / 1920` 缩放），通过 `Painter` 抽象交给两个后端：Windows 的 `windows.rs` 用 Direct2D/DirectWrite 绘制，macOS 与 Linux 的 `skia.rs` 用 tiny-skia 加系统字体绘制。

Windows 编码有两档：`gpu.rs` 把同一套排版直接画进 D3D11 纹理，`ID3D11VideoProcessor` 在显卡上转成 BT.709 NV12，再由 Media Foundation 的硬件编码器经 DXGI 采样写盘；零拷贝路径不可用时，`windows.rs` 改走 WIC 位图加 CPU NV12，但这条路径**仍开着** `MF_READWRITE_ENABLE_HARDWARE_TRANSFORMS`，所以系统内存里的帧照旧可以交给硬件编码器，只有整条链路都拿不到硬件时才落到软件编码。两条路径都只用编码器自己报告的 `MFT_ENUM_HARDWARE_URL_Attribute` 判断是否算硬件。`gpu.rs` 通过 `IDXGIFactory1` 枚举适配器，跳过 `DXGI_ADAPTER_FLAG_SOFTWARE` 并逐个尝试，避免虚拟显示适配器抢到默认设备。编码器在**第一次尝试开始前**就写入任务状态，对话框从第一帧起显示的就是真实编码器；回退到软件编码时同时写入 `fallback` 原因。非 Windows 主机走 `portable.rs` 的帧循环：macOS 优先用 `apple.rs` 的 VideoToolbox 硬件会话（建会话后读取 `UsingHardwareAcceleratedVideoEncoder` 如实报告，失败则回退），Linux 用内置的 `software.rs`（OpenH264，随包编译）；`mp4.rs` 负责写 MP4／MOV（MOV 直接按 QuickTime 品牌与 `mhlr` 处理器写出，无需事后改写）。`mov.rs` 仍只服务 Media Foundation 产出的 MP4：在 `Finalize` 之后就地把 `ftyp` 品牌和 `hdlr` 处理器改写成 QuickTime 形式，样本偏移保持不变。

目标路径来自原生对话框。编码器先在目标同目录创建隐藏暂存文件，成功后才重命名到目标；失败或取消会删除暂存文件，因此已有文件不会被半成品覆盖，也不会留下临时文件。能力按组合给出：Windows 先试零拷贝路径、失败再试 CPU 帧路径，记录实际生效的编码器；macOS 用 VideoToolbox 真编码一帧并读取 `UsingHardwareAcceleratedVideoEncoder`；Linux 由内置编码器提供 H.264（软件编码），`H.265 (HEVC)` 标记为不可用并在对话框说明原因。CSV 导出不受影响。

报告视频选项新增 `acceleration`（auto / hardware / software，默认 auto）和 `quality`（standard / high / ultra，默认 high），包含在冻结载荷和任务状态中。前后端能力缓存均按分辨率、帧率、编码、模式和画质区分；探测与实际编码采用相同的选择策略。Windows 自动模式依次尝试 GPU 纹理硬件、CPU 帧硬件、禁用硬件变换的软件编码；强制模式只尝试对应编码器，并核验真实属性。macOS 在创建 VideoToolbox 会话时通过 encoder specification 要求或禁用硬件，再读取实际模式；软件 H.264 可使用内置 OpenH264，HEVC 软件模式必须通过真实探测。Linux 明确拒绝硬件模式。只有自动模式跨硬件／软件重试，取消后不再重试，重试前清空暂存容器。

`VideoOptions::bitrate()` 统一三种编码器的目标码率。1080p30 的 H.264 标准／高清／极清为 10／20／30 Mbps，HEVC 为其 65%；按像素数和帧率线性缩放，分别最低 4／3 Mbps，最高 240 Mbps。能力响应增加 `bitrate`，供界面显示；空间预检查使用目标流大小的 125% 加 64 MiB 预留。共享排版使用 144 高参数卡和独立的名称、摘要、主读数区域，`VideoLabels` 新增 average / maximum / range / energy，保持统计口径不变。

## 协议库

`usbpd-parser` 与 `witrn-hid` 源于已停止维护的独立 `WITRN-API-RS` 仓库，最后导入提交为 `30c4bdb`。现在三个协议库统一在本仓库维护，通过 `workspace.package.version` 与应用共同版本管理，不单独发布。集成增加数值 `GeneralSample` 与由调用者维护上下文的 `decode_pd_report`；HID 设备封装保留兼容性，而 `src-tauri` 自行拥有设备句柄与后台线程。各库的 API 与示例见对应目录下的中英文 README。

三个 crate 都不依赖 Tauri，可被其他 Rust 项目直接引用；均为 `publish = false`，仅在本工作区内使用。工作区公共许可证为 LGPL-3.0-or-later。

### `crates/usbpd-parser`

USB-PD 报文解码。按报文结构分模块：`header`、`data_msg`、`ext_msg`、`pdo`、`rdo`、`vdo`、`crc`、`context`、`render`。

- 覆盖控制报文、数据报文、扩展报文，以及 Hard Reset / Cable Reset（SOP 字节 32 步编码）。
- 识别 Structured VDM 2.1。
- 解析结果是一棵带字段名、原始位范围和渲染文本的树，前端直接用来渲染详情面板。
- Feature `vendor-ids`（默认开启）内嵌 USB-IF 厂商表（13,542 条，约 500 KB），用于把 VID 显示成厂商名。
- Feature `serde`（默认开启）提供序列化。

### `crates/witrn-hid`

WITRN HID 设备封装。`device.rs` 负责打开与读取，`general.rs` 负责解码测量帧。

`decode_general_sample` 返回的 `GeneralSample`：

| 字段 | 类型 | 单位 |
| --- | --- | --- |
| `voltage` | `f32` | V |
| `current` | `f32` | A |
| `power` | `f32` | W（由 `voltage × current` 计算，不是读出来的） |
| `dp` / `dn` | `f32` | V |
| `cc1` / `cc2` | `f32` | V |
| `temperature` | `Option<f32>` | °C，字段不可信时为 `None` |
| `ah` | `f32` | Ah（仪表内部累加器） |
| `wh` | `f32` | Wh（仪表内部累加器） |

### `crates/km003c`

POWER-Z KM003C/KM002C 的 Interface 0 Vendor Bulk 协议与虚拟串口控制。`protocol::auth` 实现
MemoryRead / StreamingAuth 的 AES-128-ECB 包，`protocol::queue` 解析 20 字节 AdcQueue 样本，
`transport::bulk` 负责连接、认证、StartGraph、队列读取与 StopGraph，`trigger` 负责 CDC 文本命令。
1 ms 会话的队列序号由 `src-tauri/src/km003c_session.rs` 展开为单调主机时间，并统计序号空洞。

`detection` 将列表扫描、扩展扫描回退和常规协议缺失项补探编排成一次有时限、可取消的操作。完整检测无论报告的 PDM 版本如何，都会先尝试 `entry list+`；缺少结束标记时回退常规扫描。结果区分支持、不支持、未检查和未确认，保留扫描／补探来源和原始依据；已明确否定的协议不重试，也不从 PD 功率推断私有认证。扩展扫描等待独立 `done`，普通／完整操作的总预算为 240／420 秒。扫描正常终止后，即使仍有未确认项，命令状态也是“部分完成”；只有传输错误、缺少扫描终止标记、复位失败、取消或超时才是执行失败。检测共用已有 CDC/PDM 会话及已确认配置，不写固定 PDM 参数覆盖用户选择；正常结束发送复位，中断后下一条协议命令前复位。

`TriggerSession::run_with_detection` 提供结构化快照回调，Tauri 通过原有 `km003c-trigger-progress` 事件的可选 `detection` 字段转发。最终 `TriggerOutcome` 也包含本轮报告。所有快照仍绑定连接 `generation` 和命令 `req_id`；前端新扫描清空旧结果，取消只请求停止，直到后端返回才解锁，防止过期事件和并发命令污染本轮状态。触发动作校验实际请求的确认回复，不使用前一条协议进入回复代替。

PD 是列表结果的例外：扫描中的 PD 状态和 PDO 均不进入报告，其他扫描／补探完成后始终独立执行 `reset → entry pd → pd pdo`（取消或出错时停止）。只有确认 5 V 合约后才尝试读取完整且有效的 `Get_Revision`；若没有标准响应，则依序采用完整扫描明确报告的 PD 3.0/3.1/3.2、或 PDO 能力证明的最低版本（PPS、EPR、SPR AVS 分别证明至少 PD 3.0、3.1、3.2）。版本查询失败不会覆盖 PD 支持状态或独立 PDO，也不会阻断最终复位；查询前为复位预留预算。`ProtocolDetection.voltages` 保存本协议的电压档位／范围及类型；列表仅解析对应协议字段，单项验证只记录确认过的 5 V，PD 从独立读取的结构化 PDO 生成。仪表扫描版本与当前 PDM 设置下的 PDO 保持为不同证据；原始依据也按协议隔离，不将整段列表日志作为 PD 依据。检测不改写 `type / em / sink`。

> 仪表自己的 `ah` / `wh` 累加器会一路转发到前端，但**界面上的「累计能量 / 累计容量」并不使用它们** —— 前端对采样点自行积分，这样才能实现「暂停期间不计入积分」和「仅统计选中范围」，并由 `一键重置` 统一归零。
>
> 积分跳过「相邻点间隔过大」的空档（休眠 / NTP 前跳 / 漏采），阈值是 `max(2 s, 8 × 标称采样间隔)`，与 x 轴 `nextRecordingX` 放行点数用的是同一个倍数 —— 固定 2 秒会让 5 s / 10 s 档的每一步都被当成空档，能量恒为 `0.0000`。标称间隔的来源依次是：原生流的 `rate_ms`、导入 CSV 的 `SampTime(ms)`（旧文件从相对秒反推中位数）、`settings.sampleRate`；三者都拿不到时阈值退回 2 秒。

## 前端

`src/` 是前端源码，`tauri.conf.json` 的 `frontendDist` 指向构建生成的 `out/`。`npm run build` 合并样式并保留原生 JS 模块；`npm run build:dist` 进一步分别合并应用入口和 Worker。未配置 `devUrl`，改动源码后需重建前端并重新链接 Rust 二进制；按需浏览器预览由独立的 `tools/showcase/` 提供。`withGlobalTauri: true`，前端通过 `window.__TAURI__` 调用后端，类型在 `src/global.d.ts` 中声明，模块开启 `// @ts-check`。

关于页图标在构建时从 `src-tauri/icons/128x128@2x.png` 复制到 `out/assets/app-icon.png`，与桌面图标使用同一份资源；开发展示服务器也直接读取该文件。

关于页组件清单来自随包复制的 `src/third-party-components.json`。`scripts/third-party-components.mjs` 根据四个发布目标的锁定运行依赖图及内置资源元数据生成，普通前端构建只复制文件；维护方法见 [运行组件清单](DEVELOPMENT.md#运行组件清单)。

按职责分组：

| 分组 | 模块 | 职责 |
| --- | --- | --- |
| 装配 | `app.js`、`shell.js`、`state.js` | 入口与事件绑定、视图注册表与 Tab 切换、共享状态与类型定义 |
| 图表 | `chart.js`、`chart-buckets.js`、`chart-extrema.js`、`chart-pacing.js`、`chart-window.js`、`performance-diagnostics.js`、`theme.js` | uPlot 渲染调度、窗口极值桶与历史索引、自动刷新和绘制反馈、时间窗缩放、性能诊断与 Canvas 主题 |
| 数据 | `data.js`、`measurement.js`、`csv.js`、`provenance.js` | 采集与统计、纯函数的时间解析与能量积分、CSV 导入导出、数据来源（仪表、选点规则、软件版本） |
| 打点 | `markers.js`、`marker-ui.js` | 标记按数据集保存、标签清洗与行号规则（纯函数）；打点按钮、快捷键 M 与标记列表 |
| PD | `pd-model.js`、`views/pd.js` | 纯函数的报文摘要与过滤、PD 工作区视图 |
| 设备 | `device.js`、`temperature.js` | 连接管理、标题栏设备信息浮层（VID/PID/SN）、TCP 温度源 |
| 设置 | `settings.js`、`views/settings-view.js`、`ui-scale.js`、`theme-boot.js` | 防抖持久化、单页设置目录与会话滚动位置、50–200% 缩放、默认跟随系统并同步首帧主题 |
| 关于 | `views/about-view.js`、`third-party-components.json` | 应用信息、离线组件清单、手动更新检查与 GitHub 跳转；检查结果仅保留于会话内 |
| 界面原语 | `ui/` | `dialog` `toast` `menu` `flyout` `tabbar` `controlbar` `windowcontrols` |
| 样式 | `styles/` | `tokens`（三层设计令牌）→ `base` → `components` → `app` → `views` → `compact`（窄窗分级布局） |
| 依赖 | `vendor/` | uPlot 与 Store 插件 shim，运行时无 CDN 请求 |

`measurement.js`、`pd-model.js`、`chart-window.js` 与 `markers.js` 是刻意抽出来的**纯函数模块** —— 不接触 DOM 也不接触 Tauri，因此可以在 Node 里直接单元测试。

窗口平均同时保留有符号读数和逐帧幅值均值。前端的功率／Wh 使用功率幅值；有符号电流曲线保持净值，而 mAh 使用可选的 `currentMagnitudes` 列。`CurrentMagnitude(A)` 在需要时进入 CSV，恢复文件固定携带该列；范围统计与 Worker 复用同一幅值积分规则，缺省值回退至原有 `abs(current)`。

### 图表渲染

列按 4096 点分块，完整常量块可复用该列最近一个相同常量块；尾块独占缓冲，历史修改和 CSV 收尾补值按块复制，固定长度快照保持有效。共享使用 `Object.is` 区分正负零并保留缺失值，CSV Worker 转移时按缓冲去重。`byteLength` 统计独立缓冲，记录容量上限仍使用保守估算。

数据以列式数组存储（`F64Col`），不是 `{x, y}` 对象数组。密集窗口切换为增量 min/max 像素桶，但**完整数据仍在列里**，悬停时二分回查原始采样点，读到的是真实值。录制按 CSS 宽度调整预算，回看按实际画布像素宽度分桶；点数不超过对应分辨率时提交原始点及裁剪邻点。画布后备宽度与 CSS 宽度的比值决定实际 DPI，避免系统缩放改变而画布未更新时误算密度。主图 X 窗是会话态的时间窗口（`full` / `follow` / `frozen`），录制中右沿可贴着最新数据滑动。uPlot 侧设 `series auto: false`，避免它每帧全量扫描 min/max。

`ExactExtremaIndex` 按已完成的数据前缀复用，较早或较短的窗口只查询索引，追加样本补建尾部；清空、替换及修改原始列使索引失效。窗口变化取消过期投影，但保留已完成的索引。已有索引的投影每步最多查询 32 个桶，先在约 4 ms 内尝试完成并提交；未完成的查询、原始扫描和历史冷建使用约 1.5 ms 的协作片，只有完整投影可以发布。

绘图请求区分 `live`、`interaction` 和 `maintenance`，同帧合并到最新窗口。实际采样间隔为 1 ms 时，自动绘图在 50–100 ms 间调节；交互及维护请求可打断自动刷新计时器。健康的 100 Hz 绘图不按历史长度固定限帧。采样间隔读取记录尾部的逐点间隔，没有有效值时回退到当前设置，设备协议、CSV 和设置格式兼容性保持不变。

录制与回看各自维护密度策略；回看固定以一个画布像素为桶预算单位，慢帧不降低其精细度。回看密集曲线按通道复用同一份有界 RGBA 位图绘制原有 min/max 像素列，仅提交该通道覆盖的行；关闭填充时按原叠加顺序合并所有通道，一次上传。保留不均匀时间戳间的连线、缺失值断点和通道叠加顺序。面积填充拆成相邻条带的独立四边形，保留原有边界、基线和填充面积，避免一个大轮廓含有大量折返边；原始点仍走 uPlot 路径。

像素列位图和独立条带填充只作用于主图。导航缩略图保持 uPlot 描边，按自己的全历史点数和固定桶预算选择原始点或线性分桶路径；主图放大到原始点窗口不会改变导航投影。导航路径构建不读写主图的填充几何缓存，避免导入后描边被清空，以及导航重绘后主图填充消失。

压力反馈只测量实际 JS 绘制及绘制后的帧延迟，不计准备或导入耗时。阴影由持久化设置 `chartFillEnabled` 和各通道透明度控制，不再随压力、暂停、拖动或窗口密度自动变化。连续交互每帧合并最新窗口，松手立即提交最终投影；密度调节和节流不影响采集、保存、统计或积分。测量与边界见[性能文档](PERFORMANCE.md#测量与硬件边界)。

## 数据流

1. 前端调 `enumerate_devices` 合并 WITRN HID 与 POWER-Z Bulk 设备列表。
2. 前端调 `connect_device_by_path` 连接选中的接口；POWER-Z 先完成 Bulk 握手。
3. 后端按设备家族启动采集源、IPC 发射线程；POWER-Z 的协议控制由独立 CDC 线程拥有串口。
4. 选择 1 ms 时，采集源执行 HardwareID 读取、StreamingAuth、StartGraph(3)，每 20 ms 请求 AdcQueue；认证失败自动切回 10 ms。
5. 合法数据经事件系统推送：测量帧走 `device-data-batch`，PD 报文走 `pd-data-batch`，前端更新读数卡、图表、统计与记录文件。

## HID 报文布局

报告固定 **64 字节**，第 0 字节为报告类型；`0xFF` 是测量帧。数值均为**小端**。

| 偏移 | 类型 | 字段 | 校验 |
| --- | --- | --- | --- |
| 0 | `u8` | 报告类型，必须为 `0xFF` | 不符则拒帧 |
| 14–17 | `f32` | 累计容量 Ah（仪表累加器） | 非有限值拒帧 |
| 18–21 | `f32` | 累计能量 Wh（仪表累加器） | 非有限值拒帧 |
| 26–29 | `u32` | 运行时长（秒） | — |
| 30–33 | `f32` | D+ 电压 | — |
| 34–37 | `f32` | D− 电压 | — |
| 42–45 | `f32` | 温度 (°C) | 超出 −40 – 150 视为无温度 |
| 46–49 | `f32` | 总线电压 (V) | 超出 0 – 60 拒帧 |
| 50–53 | `f32` | 总线电流 (A) | 超出 −20 – 20 拒帧 |
| 55 | `u8` | CC1 电压，值 ÷ 10 | — |
| 56 | `u8` | CC2 电压，值 ÷ 10 | — |

功率不在报文里，由 `voltage × current` 计算。

几点重要说明：

- **电流范围放宽到 ±20 A**（K2 标称 ±10 A）是有意的：略微过冲或量化误差不应该让整帧被丢掉。
- **温度越界只按「无温度」处理，不丢整帧** —— 该偏移只在部分型号上验证过，误判温度不该连带丢掉可信的电压电流。
- **目前未实现协议校验和验证。** 新增设备型号或固件前，应先用实机样本确认字节布局与量程。

## 测试

### 前端 —— `test/`

Node 内置测试运行器（`node --test`）覆盖核心逻辑和跨文件契约，需要浏览器 API 的部分使用 mock。主要文件按领域组织如下，实际数量以 `npm test` 输出为准：

```
bench-gate  chart-binding  chart-buckets  chart-columns  chart-cooperative
chart-cursor  chart-extrema  chart-feedback  chart-pacing  chart-window  csv-codec  csv-import
device-stream  frame-scheduler  ingest  km003c-model  measurement
pd-capture-file  pd-model  range-stats  recording  recording-spool
security-csp  settings-persistence  tauri-config  temp-disconnect  version-sync
```

这些测试保护数据处理、CSV、采集、录制、协议解析、性能门禁、安全 CSP、发布版本同步和已确认的高影响缺陷。普通 UI 布局、样式、文案、控件数量和功能表面变化不单独建立回归测试；规则详见 [开发与构建：测试与回归边界](DEVELOPMENT.md#测试与回归边界)。

### Rust workspace

四个 crate 的单元、集成和文档测试由 `cargo test --workspace` 运行；`cargo fmt --check --all`、workspace Clippy 以及协议 crate 的非默认 feature 组合由 CI 固定检查。真实 HID 设备和外部温度服务仍按需手动检查，不属于自动化回归链路。

| 位置 | 覆盖 |
| --- | --- |
| `crates/usbpd-parser` | 协议字段、渲染及完整会话回放 |
| `crates/witrn-hid` | 设备接口筛选与测量帧解析 |
| `crates/km003c` | 协议、Bulk、CDC 与触发状态机 |
| `src-tauri` | 采集、合批、队列时基、文件句柄与恢复文件 |

协议库的文档测试随 `cargo test --workspace` 一并运行；测试数量以该命令的实际输出为准。

硬件相关路径（真实 HID 设备、TCP 温度服务）未接入自动化测试。

CI 的 Rust 步骤都是工作区范围（`--all` / `--workspace`），四个包全部受 fmt / clippy / test 检查；另有一个 `crate-features` job 专门跑协议 crate 的非默认特性组合。详见 [开发与构建 · CI](DEVELOPMENT.md#ci-门禁)。

开发预览由 `tools/showcase/server.mjs` 在本地 HTTP 响应中注入虚拟 Tauri 桥接，设备数据仍通过前端现有事件流摄入。模拟代码、场景与 PD 样例均位于 `src/` 外；正常构建只从 `src/` 生成 `out/`，因此安装包不包含开发工具。详见 [开发展示工具](DEVELOPMENT.md#开发展示工具)。

## 安全边界

- **CSP** —— WebView 启用内容安全策略，`img-src` 只允许 `self`、`asset:` 与 `blob:`，`connect-src` 只允许 `self` 与 IPC。`script-src` / `style-src` 均为 `'self'`，不含 `'unsafe-inline'`（Tauri 编译期会给本地脚本补 hash、给样式补 nonce）。
- **对话框能力最小化** —— `capabilities/default.json` 只授予 `dialog:allow-open` 与 `dialog:allow-save`。应用内确认框走 `<dialog>`，不授权原生 message/ask。
- **文件系统能力最小化** —— 插件权限保留 `fs:default` 与 `fs:allow-write-text-file`，不授予主目录递归写权限。CSV / PD 文件通过 Rust 文件句柄接口分块读写；路径由原生对话框或受控缓存目录决定，前端不能提交任意路径打开文件，单块最多 4 MiB。
- **窗口能力** —— 因为使用无边框自定义标题栏，需要一组 `core:window:allow-*` 权限（拖动、缩放、最大化等）。
- **本地资源与网络边界** —— 前端运行依赖全部 vendor 到 `src/vendor/`，运行时不从 CDN 加载脚本或样式。网络请求由 Rust 后端执行：用户配置的外部温度服务使用出站 TCP；仅点击关于页的“检查更新”才请求固定仓库 `KHWLGH/laPower` 的 GitHub Releases。启动和进入设置不发起更新请求。GitHub 快捷按钮经后端验证目标后调用 opener 打开系统浏览器，不接受任意 URL。
