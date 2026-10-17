# 0.2.5 - 2026-10-17

## Added

- Recording markers: click the marker button or press `M` to label a moment, or mark the point under the cursor while reviewing the main chart. The chart shows marker lines and labels, and the timeline navigator shows ticks. Rename or delete markers in the list. Enable immediate markers in Settings → Charts and recording to use a default label without a dialog and rename it later. Labels sanitize delimiters, line breaks and formula prefixes for spreadsheet use.
- Configurable shortcuts with rebinding, unbinding, per-action reset and reset-all controls; button hints update immediately. Defaults include `P` for recording, `M` for markers, `Ctrl+O` for import, `Ctrl+S` for export and `Ctrl+Shift+S` for paired export. macOS uses Command instead of Ctrl. Typing, input-method composition, dialogs and shortcut capture do not trigger these actions.
- Saved CSV export options for temperature, device information and markers, with the main button exporting directly using those options. Paired export writes `.csv` and `.pd.json` files to the same directory after one location selection and reports each result separately. Both files use snapshots taken at the same cutoff. If PD capture does not follow recording, a hint explains that their time ranges may differ; export does not crop or align them.
- CSV provenance rows `Software`, `Device` and `Points` describe the writing application version, acquisition device and sampling rule. Import and re-export preserve this information without guessing unknown or mixed sampling rules. The optional `Marker` column stores labels; recovery files also retain markers and provenance. Older files remain importable.
- A GitHub shortcut and manual update checks in About. Only clicking Check for updates requests stable GitHub release information; a newer version links to its release page. Results stay inside the About card, without automatic checks, downloads, installation or persistent prompts. Third-party components show versions, purposes and licenses, including an offline expandable list of direct and transitive runtime dependencies across all four desktop release targets.

## Changed

- Auto pause and temperature service use split buttons matching CSV export: the main button toggles the service and the arrow opens configuration. Device information moves to an information-only icon between refresh and connect. It prefers the connected device, otherwise the selected device, and works before connection.
- Settings remains a single scrolling page with a sticky directory on the left in wide windows and at the top in narrow windows, with active-section tracking. Recovery files and reset controls share a section. About moves to the end and uses a responsive horizontal application card. Returning from another workspace restores the session's scroll position.
- Scrollbars keep a fixed width and reserve space to prevent hover or content changes from shifting the layout. Settings navigation scrolls smoothly, allows user interruption and respects reduced motion preferences.
- Temperature acquisition, curve visibility and CSV temperature export are controlled separately. Disconnection preserves the selected source, display and export preferences, and recorded data; missing intervals remain empty. Importing or clearing data does not change connection preferences, importing temperature does not connect a source, and restarting still requires a manual connection.
- Chart downsampling preserves endpoints and extrema in sample order, with shared ordered geometry for the main chart and power navigator. Paged extrema indices reduce memory and append costs. Reused coordinates, intervals and per-channel fill caches reduce compositing and redundant work during pause and zoom.

## Fixed

- Fixed steep curves breaking into isolated bars or dots at intermediate zoom levels and expanded the bounded raw-point range. Missing data breaks the line, and fully zoomed views retain line geometry.
- Pausing adopts the latest complete window. Warm indices prepare detailed geometry directly; a cold pause first displays a complete coarse chart, then upgrades detail once background work finishes. Zooming, changing data or hiding the chart cancels stale work and reduces scheduling contention with the navigator.
- KM003C sequence-gap and verified-replay diagnostics now accumulate for the connection, log at a limited rate and summarize on disconnect. This improves acquisition diagnostics; it does not claim to eliminate device-side sequence gaps.

See the [user guide](../../docs/en/USAGE.md) for feature details. Chart verification scope and remaining hardware scenarios are documented in the [pause and interaction verification report](../../docs/CHART-PAUSE-PERFORMANCE.md) (Simplified Chinese).
