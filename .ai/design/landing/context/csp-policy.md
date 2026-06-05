# CSP Constraints — landing page

The page ships with this Content-Security-Policy meta tag (see `current-index.html` line 4). Every design decision must fit inside it.

```
default-src 'none';
script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval';
style-src 'self' 'unsafe-inline';
img-src 'self' blob: data:;
font-src 'self' data:;
media-src 'self' blob:;
connect-src 'self';
frame-src 'self' blob:;
child-src 'self' blob:;
worker-src 'self' blob:;
manifest-src 'self';
object-src 'none';
base-uri 'self';
form-action 'self';
frame-ancestors 'none'
```

## What this means in practice

| Want to use | Allowed? | How |
|---|---|---|
| Google Fonts / external font CDN | ❌ | Use system font stack, or embed a font as `data:` URI inline (counts against page weight) |
| External CSS file | ❌ | Inline `<style>` only |
| External image (https://...) | ❌ | Inline SVG, or `data:` URI |
| Inline SVG | ✅ | Preferred for icons/marks |
| `background: url(data:image/svg+xml;base64,...)` | ✅ | Fine for textures |
| External JS (CDN, analytics) | ❌ | Only `/zp/assets/zp-core.js` (same origin) and inline `<script>` |
| Inline `<style>` and `<script>` | ✅ | Both fine |
| CSS animations / transitions | ✅ | All native CSS works |
| Web fonts via `@font-face` with data URI | ✅ | Counts against 15KB budget |
| Tracking pixels, fetch() to external API | ❌ | `connect-src 'self'` blocks |

## Page weight budget

Target: **< 15KB total** for the full HTML file (markup + inline CSS + inline SVG + inline boot script). This is the bootstrap page — it must paint instantly before the Service Worker takes over.

If you want a real custom font, you'll burn most of the budget on it. Recommendation: use a refined system stack and put the saved bytes into typography + spacing + an inline SVG mark.

Suggested system stacks:

```css
/* Modern neutral sans (Inter-like, no download) */
font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 
             "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;

/* Monospace (for terminal/security aesthetic) */
font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, 
             "Liberation Mono", monospace;

/* Serif (rare for tools but works for editorial/Hara minimalism) */
font-family: ui-serif, Georgia, "Times New Roman", serif;
```
