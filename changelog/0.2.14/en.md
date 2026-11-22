# 0.2.14 - 2026-11-22

- Fixed the Windows GPUI chart child surface after reparenting so the main monitor and overview charts no longer collapse to a one-pixel strip or blank area.
- Corrected display ranges for near-zero voltage, current, and power while preserving real spikes and keeping traces away from the plot edge.
- Improved native GPUI stroke handling at chart boundaries so zero baselines and low-amplitude data stay visible during zooming, overview rendering, and live updates.
- Expanded the zoom regression coverage for low-amplitude data, main/overview geometry, and live-follow behavior.
