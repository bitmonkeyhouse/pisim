# Changelog

## [0.16.0] - 2026-11-03

- `/sim` with no simulator booted lists your iOS simulators, newest runtime first, and boots the one you pick (without opening Simulator.app).
- Lean mode for herdr remote connections: when a herdr client is connected over SSH, frames go at half resolution and at most 10 a second, about a thirtieth of the data. ctrl-y then `b` toggles it by hand.
- Frames are sent as RGB rather than RGBA, a quarter less data.
- The ctrl-y hint wraps onto a second row in narrow panes.

## [0.15.0] - 2026-11-03

- ctrl-y then `q` closes the viewer pane, as ctrl-c does.
- The pane is titled with the menu key, e.g. "iPhone 16 (ctrl-y for menu)".
- The ctrl-y hint fits narrower panes: it no longer lists the arrow keys (they still rotate), and it's cut at the pane's width rather than wrapping.

## [0.14.0] - 2026-11-03

- The viewer widens its herdr pane when the device turns or a foldable opens and no longer fits at physical size, and puts the old width back once it fits again. A pane you've resized yourself, or a zoomed viewer, is left alone.

## [0.13.0] - 2026-11-03

- Fold the iPhone Duo from the viewer: Ctrl-Y then `o` (open), `c` (closed), `p` (partly open) or `f` (toggle open/closed). The keys are only shown for foldables.
- `sim_fold` tool: opens, closes or half-folds a foldable and waits until the expected display is in use.
- The viewer, screenshots and taps follow whichever of the Duo's displays is lit.
- The Duo's inner display gets a bezel: Xcode's frame for the outer display, stretched to fit.

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
