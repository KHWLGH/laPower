# 0.1.2 - 2026-02-21

## Changed
- **代码重构**：将单体 `main.js`（2500+ 行）拆分为多个 ES 模块，提升可维护性
  - `app.js` — 应用入口、Tauri API 导入、窗口关闭、UI 事件绑定
  - `state.js` — 共享应用状态与类型定义
  - `chart.js` — Chart.js 初始化、降采样算法、渲染调度
  - `data.js` — 数据采集、统计、录制
  - `device.js` — HID 设备连接管理
  - `csv.js` — CSV 导入/导出
  - `settings.js` — 设置加载/保存
  - `temperature.js` — 温度服务
  - `utils.js` — 通用工具函数
- **UI 布局**：重新组织"统计"工具栏区域布局，添加分隔线与分栏排列

## Added
- **图表降采样**：新增降采样功能，大幅提升大数据量下的图表渲染性能
  - 支持 LTTB（Largest-Triangle-Three-Buckets）降采样算法
  - 支持 MinMax 降采样用于导航器
  - 提供低 / 中 / 高三档降采样强度（5000 / 2000 / 500 点）
  - 可通过工具栏开关启用/关闭
- **开发工具链**：引入 Biome 2.0 作为 linter/formatter，添加 EditorConfig、JSConfig
- **类型标注**：添加 `global.d.ts` 声明 Tauri 全局 API 类型，全面启用 JSDoc 类型检查（`// @ts-check`）
