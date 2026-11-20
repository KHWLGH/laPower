# 0.2.9 - 2026-11-21

- Made wheel zoom and timeline range dragging more responsive. The moving chart retains peaks and troughs with a bounded rendering workload, then restores full display detail. Range statistics update after the gesture, without changing samples or exports.
- Use instantaneous POWER-Z KM003C/KM002C readings and tighter scales for stable signals to preserve waveform detail. Show current magnitude in the monitor and its statistics while retaining direction and recorded values. Draw only the major chart grid.
- Refined dark glass hover highlights, added per-series stroke width and vertical offset controls, and coalesced color-picker preview updates. Moved Reset next to the sample-rate selector and reduced timeline redraws during long recordings.
