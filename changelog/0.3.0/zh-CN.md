# 0.3.0 - 2026-11-22

## 新增

- 上游融合磨砂玻璃界面材质与过渡动效，新增「设置 → 外观与语言 → 自定义背景图片」和「背景图片透明度」（0–100%，默认 0%）。支持从本地选择不超过 25 MB 的 PNG、JPG 或 WebP 图片并持久化保存，点击 `清除背景` 恢复默认背景；应用内不内置默认壁纸。Windows / Linux 保持右侧 Windows 风格窗口按钮，macOS 使用原生窗口按钮，保留 `--font-ui` / `--font-mono` 字体栈以及跟随系统、浅色和深色主题。
- 优化顶部工具栏分隔与间距，并将状态栏改为底部居中布局：在左侧提供播放/暂停记录状态切换图标按钮（暂停显示播放图标、录制中显示暂停图标），右侧依次展示记录时长、采样率、已记录点数与剩余记录容量。
- 增强主图与底部时间线导航器交互：主图与导航器均支持滚轮横向缩放，放大后支持拖动平移与平滑恢复实时跟随；新增「缩放时自动调整线条粗细」（默认开启）及分通道颜色、线宽与纵向偏移控制（偏移归零恢复默认）。同时保留既有整数/规整 Y 轴刻度、有符号/无符号电流记录语义以及完整列式存储精度。
- 新增 Windows x64 免安装便携包（`*_windows-x64_portable.zip`），与原有 MSI 和 NSIS 安装包一并生成与校验，正式发布共包含八个产物并附带 `SHA256SUMS`。
- KM003C 轮询采集路径（`src-tauri/src/km003c_session.rs`）改用瞬时电压/电流字段（`vbus_instant_v()`、`ibus_instant_a()`）并据此计算瞬时功率，避免仪表端显示均值掩盖亚秒级变化。
- 在四语言 README 中为社区贡献者 [weixunkkkkk](https://github.com/weixunkkkkk)（#1）、[asdmoment](https://github.com/asdmoment)（#4–#9）与 [xiaokangzaina](https://github.com/xiaokangzaina)（#11）添加单行致谢并列出各自主要贡献。

## 性能与维护

- 深度优化 WebView2 Canvas 2D / `OffscreenCanvas` 增量像素桶渲染管线：像素桶栅格化采用二维水平脏矩形局部重绘替代全画布清空，缓存通道列索引、跳过屏幕外列、在悬停/平移/缩放路径中使用零分配循环和压缩 RGBA 像素写入，并在缩放对齐序列上使用三点仿射快速路径。
- 新增 `bench/chart-zoom.mjs` 缩放/平移微基准脚本，重构并精简四语言 README、[使用指南](../../docs/USAGE.md)、[开发指南](../../docs/DEVELOPMENT.md)、[技术架构](../../docs/ARCHITECTURE.md)与[性能说明](../../docs/PERFORMANCE.md)。
