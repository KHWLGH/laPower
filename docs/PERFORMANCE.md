[English](en/PERFORMANCE.md) | **简体中文**

← 返回 [README](../README.zh-CN.md)

# 性能基准与边界

本文记录可重复的算法、存储、启动与发货形状基准，用于评估性能优化；不把浏览器帧率或真机长跑作为每次提交的自动门禁。

- [测量范围](#测量范围)
- [前端产物](#前端产物)
- [存储与数据完整性](#存储与数据完整性)
- [报告准备与有界恢复](#报告准备与有界恢复)
- [密集图表显示预算](#密集图表显示预算)
- [按需调度与缓存复用](#按需调度与缓存复用)
- [测量与硬件边界](#测量与硬件边界)
- [启动测量限制](#启动测量限制)
- [CI 与手动验证](#ci-与手动验证)

## 测量范围

| 基准 | 命令 | 关注点 |
| --- | --- | --- |
| 核心算法 | `node bench/core.mjs` | 列存储、分桶、范围统计、能量积分 |
| 算法阶段对照 | `node bench/phase2.mjs` | 范围统计与协作切片前后对比 |
| 存储阶段对照 | `node bench/phase3.mjs` | 分块存储、统计与能量计算前后对比 |
| 长期记录内存 | `npm run bench:memory` | 常量块共享、流式 CSV 导入、追加快照与清空释放 |
| 极值算法对照 | `node bench/extrema.mjs` | 逐样本扫描与极值索引对照 |
| 启动分段 | `node bench/startup.mjs` | 原生冷启动各阶段耗时与资源形状 |
| 图表交互缩放 | `node bench/chart-zoom.mjs` | 滚轮缩放／平移帧耗与 Canvas 2D 渲染管线 |
| 发货形状 | `node bench/packaging.mjs` | `out/` 产物集合、阻塞资源与孤儿资产 |
| Rust 基准 | `cargo bench -p lapower` | 协议解码、编码与选择路径 |

`bench/core.mjs --compare` 基于 `bench/baselines/` 的输入指纹与指标集做多轮对照；`--verify-baseline` 仅运行一次数据正确性与基线结构校验（不预热、不计时，供 CI 使用）。共享 runner 的单次耗时受负载与缓存影响，仅作参考而不直接升级为门禁阈值。

## 前端产物

`npm run build` 将 `src/` 镜像到 `out/` 并合并样式表，保留原生 JS 模块；`npm run build:dist` 进一步合并应用入口及四个 Worker（两个 CSV Worker、PD 导出 Worker、范围统计 Worker），保留 Worker 文件名并清理被合并模块。`node scripts/build-dist.mjs --bundle-js` 可输出未压缩合并版本用于启动对照；typecheck 与 Node 核心测试直接运行源码。`bench/packaging.mjs` 在 `validate` 中验证：

- `out/` 镜像文件均已被 Git 跟踪，合并产物与关于页图标由构建脚本生成；
- `.d.ts` 与点号目录未进入发货集合；
- `index.html` 不含内联脚本，所有资源引用有效且无孤儿资产。

## 存储与数据完整性

### 常量块共享与导入分配

在 Windows / Node 独立进程中对比修改前后源码（固定 1 ms 间隔、无温度、5 个录制段、其余信号逐点变化，追加并保留导出快照后补入 4097 点；列缓冲按独立 `ArrayBuffer` 统计，RSS 为每块处理后抽样峰值）：

| 场景 | 原始点数 | 列缓冲节省 | 修改前 / 后 RSS 峰值（MiB） |
| --- | ---: | ---: | ---: |
| 持续追加 | 1,000,000 | 24.5% | 150.0 / 127.0 |
| 流式 CSV 导入 | 1,000,000 | 24.5% | 255.3 / 230.8 |
| 持续追加 | 5,000,000 | 24.9% | 523.8 / 409.0 |
| 流式 CSV 导入 | 5,000,000 | 24.9% | 747.4 / 595.2 |

所有列 SHA-256 前后完全一致，清空并 GC 后数据缓冲回到初始水平（连续三次替换保持稳定；本测未统计 Tauri / WebView2 / GPU 全进程树）。

分块列存储以 **4096 点** 为一块：完整常量块在同一列内共享最近一个相同常量块（`Object.is` 区分正负零并保留缺失值），尾块独占缓冲，历史修改或补值按块复制，Worker 传输对共享缓冲去重。每点记录实际 `SampleInterval(ms)` 供混合采样率判定积分空档；12 列原始数据与辅助索引约 112 字节/点，CSV 约 128 字节/行。

恢复文件表头立即同步，Rust 每秒刷盘并唤醒前端回写；大回填每轮仅捕获一次固定快照，失败保留文件、仅正常同步收尾删除，并兼容扫描 `stem.partial-2.csv`。大范围统计使用单个可复用 Worker 按原序折叠（每次最多 4096 行、启动间隔 `max(250 ms, 上次耗时 × 4)`）；PD 导出在 Worker 内以每批 ≤ 128 条、单块 ≤ 1 MiB 写入，维持 v2/v1 兼容。

## 报告准备与有界恢复

图片与视频报告共用 `video-projection.js` 的增量投影内核，每步最多处理 4096 个样本或标记操作并以约 1.5 ms 协作预算让出主线程；列快照、标记、来源与录制状态在首次让出前冻结，支持取消与退出清理。

2026-11-10 在 Windows / Node 24.18.0（1 ms 间隔、无温度、1 个录制段、256 桶、1 ms 模拟事件定时器）三轮实测对照如下：

| 样本数 | 修改前同步阻塞 | 异步最长计算片 | 异步总耗时（含让出） | 每轮事件回调数 |
| --- | ---: | ---: | ---: | ---: |
| 1,000,000 | 83.6–113.8 ms | 2.03–2.44 ms | 1.08–1.74 s | 78–119 |
| 5,000,000 | 488.5–510.0 ms | 2.46–4.53 ms | 6.00–6.03 s | 410–423 |

Node 下无 `scheduler.postTask` 时退回 `setTimeout(0)`（事件回调最大间隔 16.4–18.4 ms），用于验证主线程事件可调度性而非计算加速；原生 WebView 延迟与长跑仍需实机验证。

PD 补洞以连续消费游标推进（每页最多 512 条并固定终点 `throughSeq`），按需详情树前端最多缓存 8 条；TCP 温度线程以 1024 字节读入 256 字节行缓冲并丢弃超长无换行流。

## 密集图表显示预算

每桶每通道按源下标升序去重保留首点、末点与最早最小/最大值（仅当省略区间全为有限值时连线，悬停始终二分回查原始样本）。

- **极值索引与协作分片**：`ExactExtremaIndex` 每页 256 节点保存八通道下标与有限计数（24 KiB/页；360 万点约 21,823,488 B，追加不复制历史页）。已完成前缀直接复用，缩小或左移窗口仅查索引而不全扫；录制时以 1 ms 预算 / ≤ 1024 样本预热前缀，冷暂停复用同源完整录制投影并同步补齐 ≤ 4096 尾点后原子升级。已有索引投影按每步 ≤ 32 桶（原始扫描 ≤ 4096 点）计量，先在 ~4 ms 内尝试当帧提交，未完部分以 ~1.5 ms 协作分片完成；过期窗口取消不销毁有效索引。
- **双模式桶预算与原样恢复**：自动录制默认每 2 CSS 像素 1 桶（压力档位 1/2/4/8/16 像素，降档仅在录制中触发：连续两次超过 `max(33 ms, 空闲帧间隔 × 2)` 降一档、单次超 100 ms 降两档，稳定 2 秒后每 5 秒最多恢复一档）；回看固定按 **1 设备像素/桶** 保持精细度，永不因慢帧放宽。回看放大至点数 ≤ 4 × 绘图区设备像素宽度（且 ≤ 16384 点及往返预算内）时恢复原始点及裁剪邻点；导航缩略图固定每 2 CSS 像素 1 桶。
- **Canvas 2D / `OffscreenCanvas` 光栅化与曲线阴影**：密集主图在拥有 `OffscreenCanvas` 且主曲线为纯色不透明描边时，按设备像素列光栅化进转置 `Uint32Array` 位图，仅重清与上传二维脏矩形边界并复用几何/RGBA 缓冲，同时以 3 点仿射探针跳过冗余投影；开启阴影或高往返时以逐像素列解析面积覆盖在同一次上传中合成。曲线阴影仅由持久化的 `chartFillEnabled` 与分通道 0–100% 不透明度控制，不随慢帧、暂停或缩放自动开关。
- **帧调度与诊断字段**：绘图区分 `live`、`interaction`、`maintenance`（1 ms 采样时自动刷新在 50–100 ms 间调节；交互打断限帧定时器）。`window.__WITRN_PERF__().charts.main.last` 暴露 `sourcePointCount`、`displayPointCount`、`pixelsPerBucket`、`displayDense`、`fillEnabled`、`recentAppendCount`、`refreshSource`、`refreshIntervalMs`、`drawMs`、`nextFrameDelayMs`、`frameDelayMs` 及兼容字段 `fillSuppressed: false` / `fillSuppressionReason: null`（历史上限 512 项）。

## 按需调度与缓存复用

- **诊断与状态刷新**：常规运行仅在启动、窗口恢复与实际绘图后采样（无常驻空闲 rAF）；`window.__WITRN_PERF_START__()` / `STOP__()` / `RESET__()` 用于按需开启连续帧、DOM 与长任务采样。非监控页全局计数最多每 250 ms 更新一次。
- **导航与 Worker 复用**：导航维持独立的单通道功率极值索引（360 万点约 2,727,936 B），尺寸变化仅重建显示投影；范围统计串行复用单个 Worker 与最多 4096 行（≤ 256 KiB）的八列 scratch 缓冲；恢复文件按持久化行数与表头版本去重检查点，后端 IPC 队列空时阻塞等待。

## 测量与硬件边界

- 浏览器基准共享[无头测试接口](DEVELOPMENT.md#无头测试接口)，`recording-spool` 等由 `npm test` 保护；模拟运行不能替代同机对比、完整主题/DPI 矩阵与真实仪表长跑。
- 同机性能比较须固定构建、主机、窗口尺寸、DPI、通道数、采样率、数据分布与公开百分数填充设置（如 `12` 表示 12% 填充），区分录制、热暂停、冷暂停与连续交互，并分别记录首图、最终精细图、`draw`、后续 rAF 与最长停滞间隔（本机观察目标 p95 帧间隔 ≤ 33 ms、交互响应 ≤ 50 ms；极端八通道高频交变仍可能超出）。
- 真机验收须保持桌面解锁与窗口前台可见，在 100 / 1000 次/秒下分别连续录制 ≥ 5 分钟，核实实测采样率、原始点数、队列序号空洞、尾点与交互延迟（历史恢复续采样本或部分通道缺测样本不能替代完整无中断实机长跑）。

## 启动测量限制

`bench/startup.mjs` 的冷启动绝对毫秒仅适合同批次、同构建、相近主机状态下的横向对照，需随环境与主机探测信息一并记录；前端依次打点 `uiReady`、`listenersReady`、`devicesScanned`、`recoveriesScanned` 与最终 `appReady`（异常记录扫描不阻塞 `appReady`）。

## CI 与手动验证

CI 的 `validate` 仅运行确定性的 `bench/packaging.mjs` 与 `bench/core.mjs --verify-baseline`；算法、内存、缩放与 Rust 耗时基准按需在本机执行：

```bash
npm run build
node bench/packaging.mjs
node bench/core.mjs --verify-baseline --output bench/results/verify.json
node bench/core.mjs --compare
npm run bench:memory
node bench/chart-zoom.mjs
node bench/phase2.mjs
node bench/phase3.mjs
node bench/extrema.mjs
node bench/startup.mjs
cargo bench -p lapower
```

真机硬件验收由维护者按需执行；新增测试规则见 [测试与回归边界](DEVELOPMENT.md#测试与回归边界)。
