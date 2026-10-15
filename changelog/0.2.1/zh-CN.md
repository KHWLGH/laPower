# 0.2.1 - 2026-08-29

## Added
- **非聚焦窗口材质**：设置 → 外观在「窗口材质」下新增「允许非聚焦窗口使用窗口材质」。开启后失去焦点仍保持 Mica，不再回退纯色
- **图表滚轮横向缩放**：在主图上滚动以光标为锚缩放时间窗；录制中可用。右沿贴着最新数据时跟最新走（固定时长），否则定住历史片段。时间线滑块同步，暂停后再继续不会丢掉已缩的窗
- **时间线选区可平移**：拖动导航条中间高亮范围可整体移动窗口（跨度不变）；两端手柄仍负责缩放
- **Windows 11 Mica 窗口材质**：设置 → 外观新增「窗口材质」开关（默认开，仅 Win11 可用时显示）。远程桌面或录屏下若透底，可关掉改回不透明底色
- **读数栏仪表化**：电压/电流/功率/温度主卡为标题 + 圆角横向电平条（包住大字读数）+ 最小/平均/最大三列；能量与信号线卡为水平迷你条；量程按会话观察最大值走 1-2-5 取顶。最小窗口（900×600）连温度卡也一屏完整露出
- **监控读数栏可拖宽**：右侧分栏条 200–360px，默认 250px，宽度写入配置
- **命令栏溢出菜单**：宽度不足时把导出 CSV / 导入 CSV / 一键重置收进 `⋯`，不再一刀切把整栏图标化
- **PD 分栏方向**：宽屏（≥1400px）可改为左右分栏，偏好持久化
- **状态栏时长与采样率**：记录状态可点击启停；新增累计时长与当前采样率
- **PD 厂商名**：Vendor Defined 的 VID 在列表 Note 与详情里显示 USB-IF 厂商（如 `0x05AC [Apple]`）；未登记写 `[Unknown Vendor]`。SVID（含 PD SID `0xFF00`）保持十六进制

## Changed
- **大窗口高速记录更跟手**：显示桶改为每 CSS 像素一对 min/max；录制中桶路径也能在 Y 极值未破时跳过四轴量化；导航图约 10 Hz 刷新；flatten 复用 typed array；超预算时按约 30fps 让帧
- **读数主卡横向电平**：电压/电流/功率/温度的当前读数改为圆角横向电平条（底色与填充为同一通道不同色度）；数字居中并占满条面；标题恢复通道色圆点，卡内文字用常规文本色
- **图表次网格**：两个主格线之间由对分改为 5 等分
- **标题栏连接区**：`连接` / `断开` 合并为单颗状态按钮，拖拽区加宽
- **图标体系**：界面图标从 Codicons 换成 Fluent System Icons（MIT）
- **轻量分层**：卡片补 elevation 与暗色顶边高光；PD 行 hover 与 Tab 下划线改为短 CSS 过渡，不加 JS 动画
- **设置页二态控件**：窗口材质、记录电流方向改为 ToggleSwitch；滚动条默认更淡，容器悬停时加粗显形
- **移除内建 Maple Mono**：等宽英数与中文改走各平台原生字体。Windows：界面 Segoe UI Variable Text / Segoe UI + 微软雅黑，等宽 Cascadia Mono / Consolas；macOS：界面 -apple-system / PingFang SC，等宽 SF Mono / Menlo；Linux：界面 system-ui / Noto Sans CJK SC，等宽 `ui-monospace` / Noto Sans Mono。`html[data-os]` 提前到 `theme-boot.js`，首帧即选对字体栈。
- **图表列只保留 `chartSeries`**：去掉与之同对象的 `chartData` 别名

## Fixed
- **Windows 窗口按钮方块字**：部分 Win10 缺少 Segoe Fluent Icons / MDL2 时，decorum 私用区字形会显示成方块。保留 decorum 按钮与贴靠浮窗，内容改用内置 Fluent SVG
- **读数栏排版**：大字读数左对齐并用 `tabular-nums`；最小 / 平均 / 最大三列改为左 / 中 / 右对齐，不再被省略号规则套到内层数字上
- **窄窗读数栏过宽**：小窗口下侧栏仍按 250px 计，主卡右侧留白过大。视口 <1080（或高度 <620）上限 220px，<980 上限 200px。被上限卡住时拖动分栏不再改写大窗口下的宽度偏好
- **拖动读数栏卡顿**：分栏拖动期间跳过图表的 `ResizeObserver`，宽度写入合并到 rAF，松手后再 `setSize`
- **导入 CSV 后仍显示「暂无数据」**：`importCSV` 写完列数据后补一次 `updateChartEmptyState`
- **Mica 不可见、深色发蓝**：WebView 画布改为全透明，`color-scheme` 从 `:root` 下沉到 `.app-shell`，浅色主题不再盖掉 Mica 令牌；外壳用中性灰半透明罩层。开 Mica 时优先 `apply_tabbed`（Mica Alt）
- **导入 CSV 不再改采样率**：文件里的相对秒已是 x 轴；继续记录用当前设置的间隔，`SampTime` 只作元数据
- **开始记录连点**：`set_pd_capture_enabled` 完成前拒绝重入
- **PD 导入 / 清空世代**：meta-only 导入等待 `pd_log_clear` 的新 generation；清空失败不再把闸门钉在 `-1`；补洞与 `pd_log_replace` 长度不一致时不再丢掉已成功的后端日志
- **自动暂停 duration=0**：阈值一满足立即暂停
- **导入能量跳过休眠空档**：相邻点间隔超过 2 秒不积进 Wh/mAh
- **重置设置后自动暂停单位**：`#ap-unit` 与阈值单位一并回显
- **损坏配置 `rangeStart > rangeEnd`**：分别钳位后交换
- **窗口按钮 Promise**：最小化 / 最大化 / 拉伸失败不再变成未捕获拒绝
- **Flyout 滚动关闭**：与下拉菜单一致，外部滚动时收起
- **连接连点**：HID 与温度服务各自加 in-flight 锁
- **PD IPC 背压**：通道满时 pending 最多 256 条，日志不丢；拔线改 `try_send` 并排空后再发断开
- **采样节流**：通道 Full 时不推进 `last_emit`，下一轮立即重试
- **打开失败**：已拆掉旧会话时清空设备信息并通知断开
- **`pd_unpack`**：拒绝非 `0xFE` 报告头

## Security
- **收紧 capability 与 CSP**：`dialog:default` 收窄为 `dialog:allow-open` + `dialog:allow-save`（应用内确认框走 `<dialog>`，不再授权原生 message/ask）。CSP 的 `script-src` / `style-src` 去掉 `'unsafe-inline'`。已在 Windows WebView2 上验证；Linux GUI / WebKitGTK 未做运行时冒烟。

## Removed
- 内建 `MapleMono-NF-CN-Regular.ttf` 及对应 `@font-face`
- Codicons 字体与 `codicon.css`（改用 Fluent System Icons）
- **仪表签名 / 指纹**：设置页「读取设备身份」、Tauri `identify_current_device`，以及 `witrn-hid` 的 `info.rs` / `identity()` / `identify` example。设置页仍显示 HID 枚举的 VID/PID/SN；USB-PD Discover Identity 报文解码保留
- 按 VID/PID 连接的 `connect_device` 命令（两台同型号会连错；前端只用 path）
