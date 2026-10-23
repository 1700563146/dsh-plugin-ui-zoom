# dsh-plugin-ui-zoom

Whole-interface zoom for DeepSeek Harness (DSH): scale the **entire** Web UI — sidebar, menus, modals, icons and text — from 70% to 160%.

Built-in DSH font size only affects conversation prose. This plugin scales everything, and compensates the layout so zooming out shows **more text per line** instead of a narrower reading column.

## Features

- **Ctrl+wheel** zoom, 5% per notch, accumulated over trackpads so a two-finger swipe does not jump ten steps
- **Keyboard shortcuts registered with DSH's own shortcut center** (`Mod+=` / `Mod+-` / `Mod+0` on Desktop, `Mod+Alt+…` on Web), so they appear in `Mod+/` and users can rebind them
- **Inline pill** next to the composer: `− 100% +`, click the percentage to reset
- Range 70%–160%, remembered per origin in `localStorage` (`dsh-ui-zoom`)
- Content-width compensation: the host caps the reading column at 920px, so the cap is scaled by `1 / zoom`, keeping the column's physical width stable
- Cleans up after itself: removing the plugin restores the document and drops every listener and command

## Install

Install it from the **Plugins** page in DSH (search the npm name), or:

```sh
dsh plugin --profile <profile> add dsh-plugin-ui-zoom
```

Restart `dsh web` afterwards.

## Usage

| Action | Desktop | Web |
|---|---|---|
| Zoom in | `Ctrl/⌘` + wheel, `Mod+=` | `Ctrl+Alt+=` |
| Zoom out | `Ctrl/⌘` + wheel, `Mod+-` | `Ctrl+Alt+-` |
| Reset to 100% | click the percentage, `Mod+0` | `Ctrl+Alt+0` |

`Mod` is `⌘` on macOS and `Ctrl` on Windows/Linux. All three bindings are editable in DSH's keyboard shortcut panel (`Mod+/`); the plugin registers through `ctx.shortcuts`, so duplicate or overlapping bindings are rejected by the harness instead of silently double-firing.

## Why it scales `#root`, not the document

Most DSH font sizes are hard-coded pixels with no `rem` ladder, so overriding design tokens cannot scale the whole interface. `zoom` participates in layout, so hit testing and fixed elements follow — unlike `transform: scale()`, which creates a containing block that traps fixed elements.

The zoom is applied to `#root`, **not** `document.documentElement`, and that is the whole trick:

- Every DSH overlay is portaled to `document.body` (`MenuSurface` → `createPortal(list, document.body)`, `HoverCard` → `createPortal(content, document.body)`), including overlays owned by third-party plugins that reuse the host's primitives.
- Those overlays position themselves from `getBoundingClientRect()` (screen pixels) and write the result back as `left`/`top`.
- If the zoom covered `body`, that written value would be multiplied by the zoom a second time — at 120% a menu drifts 20% toward the bottom right and leaves the screen.
- Keeping `body` outside the zoomed subtree restores the coordinate math.

Because `zoom` does not enlarge the layout viewport, `#root` also gets `width`/`height: calc(100% / zoom)` so the box still fills the window.

## Compatibility

- `engines.dsh`: `>=0.2.0-rc.2 <0.3.0-0`
- Peer: `@deepseek-ai/cordis` `^4.0.1`
- No build step, no runtime dependencies

## Known limitations

- **Overlays do not scale with the interface.** Menus, dropdowns and hover cards keep their 100% size because they live outside the zoomed subtree; positioning them correctly and scaling them are mutually exclusive without host support for page-level zoom. Position wins.
- If you have dragged the conversation width handle, the host stores its own inline width and it wins over this plugin's compensation; zooming out then scales the column proportionally.
- On Web (a real browser tab), `Ctrl+wheel` is the browser's page zoom and cannot be intercepted; use the `Alt` bindings there.

## License

MIT
