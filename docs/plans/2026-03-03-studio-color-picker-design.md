# Studio Color Picker Design

**Date:** 2026-03-03

## Problem

Studio colors are assigned by hashing the studio name into a 6-color Tailwind palette. Two studios can collide to the same color with no way to override. Unconfigured studios (not in `config.studios`) already show distinct colors by chance; configured studios do not have a manual override.

## Goal

Let users assign an explicit color to each studio. The color is used everywhere a studio chip appears: calendar grid, legend, stats bar, invoice table (future).

## Data Model

`StudioConfig` gains one optional field:

```ts
color?: string; // hex, e.g. "#a78bfa"; absent = auto-assign from palette
```

Zod schema validates with `.regex(/^#[0-9a-fA-F]{6}$/).optional()`.

When a studio is **created** (Add Studio button or Configure shortcut from the calendar), it is auto-assigned the first palette hex not already used by another studio. This prevents collisions at creation time. The user can then override via the picker.

## Color System

`src/lib/studioColors.ts` is rewritten:

- Palette becomes 6 hex strings (exact equivalents of the current Tailwind swatches: violet, sky, emerald, amber, rose, teal).
- `studioColor(name: string, hex?: string): { backgroundColor: string; color: string; borderColor: string }` — returns a React `style`-compatible object.
- When `hex` is provided (stored config value), compute from that hex.
- When absent, fall back to `PALETTE[hash(name) % 6]`.
- Color computation from any hex via HSL:
  - `backgroundColor`: `hsl(h, s%, 93%)`
  - `color` (text): `hsl(h, s%, 25%)`
  - `borderColor`: `hsl(h, s%, 70%)`
- Export `PALETTE_HEX: string[]` for the swatch tab.

All call sites (`CalendarTab`, `CalendarGrid`) switch from Tailwind `className` to `style={studioColor(...)}`.

## Auto-assign Helper

`src/lib/studioColors.ts` also exports:

```ts
export function nextUnusedColor(usedHexes: string[]): string;
```

Returns the first `PALETTE_HEX` entry not in `usedHexes`, wrapping around if all are used.

Called in `App.tsx` (`handleAddStudio`) and `RatesTab` (`addStudio`) when constructing new `StudioConfig` objects.

## Color Picker Popup

New component: `src/components/ColorPickerPopup/index.tsx`.

**Trigger:** A small filled circle (16 × 16 px, colored with the studio's current color) in the `StudioCard` header, left of the studio name. Clicking it opens the popup; clicking outside closes it.

**Popup layout:**

```
┌─────────────────────────┐
│ [Swatches] [Radial]     │  ← tab bar
├─────────────────────────┤
│                         │
│  ○ ○ ○ ○ ○ ○           │  ← swatch tab: 6 circles
│                         │
│  (or)                   │
│                         │
│  [HexColorPicker wheel] │  ← radial tab
│                         │
└─────────────────────────┘
```

- **Swatches tab:** 6 circles using `PALETTE_HEX`. Active swatch has a ring. Clicking selects and closes the popup.
- **Radial tab:** `react-colorful`'s `HexColorPicker`. Color updates live as the user drags; popup stays open until click-outside. Accepts free-form hex output from the picker.

**Props:**

```ts
interface ColorPickerPopupProps {
  currentColor: string; // hex
  onColorChange: (hex: string) => void;
  onClose: () => void;
}
```

Positioned as `absolute` via a wrapper `div position: relative` on the StudioCard header trigger.

## StudioCard Changes

- Add `onUpdateColor: (studioName: string, hex: string) => void` prop.
- Render the color dot trigger in the header, and `ColorPickerPopup` when `pickerOpen` state is true.
- `updateStudioField` in `RatesTab` already handles arbitrary fields; extend to cover `'color'`.

## Dependencies

Add `react-colorful` (HexColorPicker, ~3 KB gzip).

## Files Changed

| File                                                | Change                                                   |
| --------------------------------------------------- | -------------------------------------------------------- |
| `src/lib/types.ts`                                  | Add `color?: string` to `StudioConfig`                   |
| `src/lib/config/schema.ts`                          | Add optional `color` field                               |
| `src/lib/studioColors.ts`                           | Rewrite: hex palette, HSL computation, `nextUnusedColor` |
| `src/components/CalendarTab/index.tsx`              | Switch `className` → `style` for color chips             |
| `src/components/CalendarTab/CalendarGrid/index.tsx` | Switch `className` → `style` for class chips             |
| `src/components/ColorPickerPopup/index.tsx`         | New component                                            |
| `src/components/RatesTab/index.tsx`                 | Wire color dot + picker, auto-assign on add              |
| `src/App.tsx`                                       | Auto-assign color in `handleAddStudio`                   |
| `tests/fixtures/config.yaml`                        | Add `color` to one studio                                |

## Testing

- Unit tests for `studioColor()` and `nextUnusedColor()` in `tests/lib/studioColors.test.ts`.
- Schema test: valid hex accepted, invalid string rejected, absent accepted.
- Browser smoke test: open RatesTab, click color dot, switch tabs, pick a color, verify CalendarTab chip color updates.
