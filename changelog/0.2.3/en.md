# 0.2.3 - 2026-10-09

## Added

- Added Traditional Chinese, English and Japanese interfaces alongside Simplified Chinese. The default follows the system language, falling back to English for unsupported languages. Linux checks `LC_ALL → LC_MESSAGES → LANG`; Windows and macOS use the native system locale.
- Added a language selector in Settings. Switching takes effect immediately and saves the preference while preserving device connections, recording, data, chart range, PD filters and the selected message. Resetting settings returns to automatic selection.
- Added four offline dictionaries, structured backend messages, locale-resolution and persistence tests, and a multilingual verification tool using simulated devices.
- Provided complete four-language READMEs, user guides, external temperature service documentation and development/build guides, together with localized light/dark screenshots.
- Added “Settings…” (⌘,) to the native macOS application menu, opening the same Settings page as the title-bar gear button.

## Changed

- The GitHub landing page now defaults to English.
- Charts, menus, dialogs, notifications, recovery records, window controls, accessibility labels, and application-provided file-dialog titles/filters follow the selected language. PD standard fields, raw device replies, units, and CSV/PD file formats remain compatible.
- Adjusted font fallbacks and long-text layouts for all four languages and narrow windows.
- macOS now uses native traffic-light controls without changing the title-bar layout. The system handles window buttons, fullscreen, tiling, rounded corners and shadows. Double-clicking empty title-bar space zooms or minimizes according to System Settings → Desktop & Dock. Native buttons cannot be skinned; the Window style setting is shown only on Windows/Linux.

## Fixed

- Proofread the four-language interface and user documentation: corrected Japanese pause/recovery wording, unified Traditional Chinese terminology, and clarified the meter temperature source, PD follow mode, and operation after reaching the recording limit. Refreshed the 0.2.3 light/dark screenshots in language subdirectories and removed duplicate root images.
- Corrected obsolete PD column names, standalone capture pause behavior and temperature-service newline instructions; documented the appearance language setting.
- Fixed release builds failing at the first procedural macro on macOS 27 + Xcode 27.0 (beta): inherited release stripping caused dyld to reject a dylib because its LINKEDIT string pool was misaligned. Build scripts and procedural macros, which are not shipped in the installer, are no longer stripped.
- Disabled WKWebView background throttling for the main window on macOS 14+ (ignored on Windows/Linux). The default policy throttled hidden, minimized or obscured windows and suspended the page after roughly five minutes. Without frontend sample acknowledgments, acquisition stopped at 8192 unacknowledged samples—about eight seconds at a 1 ms sample interval.
- Disabled App Nap and requested maximum timer precision (`LatencyCritical`) while the reader thread is alive, preventing hidden-window HID reads and batch timers from being coalesced or deprioritized. macOS hidapi buffers only 30 reports per device; late wakeups lose samples. On a WITRN K2 at 100 samples/s with the window minimized for three minutes, disabling App Nap alone yielded a maximum interval of 36 ms with roughly 0.2–1% of points merged. Adding `LatencyCritical` reduced the maximum to 18.8 ms and retained all samples.
- Prevented idle system sleep while recording on macOS (equivalent to `caffeinate -i`), so unattended recordings are not interrupted by automatic sleep. The display may still turn off; pausing or stopping releases the assertion. Acquisition without recording does not prevent sleep.
- Fixed unused-code and `drop_non_drop` diagnostics from the new macOS modules causing Clippy CI failures on Windows/Linux.
