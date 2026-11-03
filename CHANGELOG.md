# Changelog

## [0.12.0] - 2026-11-03

- Rotate the device from the viewer: Ctrl-Y then `r` or `→` (clockwise) or `←` (anticlockwise). The picture, bezel and clicks turn with it.
- The viewer shows the device at its real physical size, following the display the terminal window is on; Ctrl-Y then `z` zooms to fill the pane.

## [0.11.0] - 2026-11-03

- Screenshots at the top of the README.

## [0.10.0] - 2026-11-03

- First published release, as `@bitmonkey/pisim`: README, MIT licence and NOTICE for idb.

## [0.9.0] - 2026-11-03

- `sim_button` presses Home, Lock, Siri and volume; in the viewer, Ctrl-Y then `h`, `l`, `s`, `+` or `-`.
- The accessibility tree is read by `simhelper describe`, so AXe is no longer needed.

## [0.8.0] - 2026-11-03

- The native helpers are one binary, `simhelper`.

## [0.7.0] - 2026-11-03

- The bezel is rendered with Core Graphics in `simhelper`, so ffmpeg is no longer needed.

## [0.6.0] - 2026-11-03

- The viewer streams the display itself, only when it changes, scaling frames on the GPU: no CPU while the screen is still.

## [0.5.0] - 2026-11-03

- `sim_tap` and `sim_type` go through the native input helper.

## [0.4.0] - 2026-11-03

- Input goes through a native helper that keeps one connection to the simulator open: taps land in about 0.1 s, and the mouse is passed through live, so long-presses and flicks work.

## [0.3.0] - 2026-11-03

- Click, drag and type in the viewer to drive the simulator.

## [0.2.0] - 2026-11-03

- The viewer streams at about 18 fps without flicker.

## [0.1.0] - 2026-11-03

- `/sim` shows a booted simulator in a herdr pane, in its device bezel.
- Agent tools: `sim_screenshot`, `sim_describe`, `sim_tap`, `sim_type`, `sim_launch` and `sim_open_url`.
