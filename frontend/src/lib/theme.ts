/**
 * Pure Milk POS — central design tokens.
 * Do NOT hardcode hex values in components; import from here.
 */

export const COLORS = {
  // ── Brand (blue) ─────────────────────────────────────────────────────────
  brand: '#1B4C82',        // primary blue
  brandDark: '#123A66',    // hover/pressed blue
  brandTint: '#EAF2FB',    // light blue tint for active/hover backgrounds
  brandTintSoft: '#F5F9FE',
  brandBorder: '#D7E6F7',

  // ── Ink (text scale — stays dark/neutral, screenshot text is black) ───────
  ink: '#0F1720',
  inkHover: '#0F1720',
  inkBody: '#1F2530',
  inkMuted: '#6B7280',
  inkFaint: '#9CA3AF',
  inkDisabled: '#C7CDD6',

  // ── Surfaces ─────────────────────────────────────────────────────────────
  surface: '#FFFFFF',
  surfaceAlt: '#F7F9FC',
  surfaceSunken: '#F1F4F9',
  border: '#E5E9F0',
  borderStrong: '#D7DEE9',

  // ── Semantic ─────────────────────────────────────────────────────────────
  danger: '#EF4444',
  dangerTint: '#FEF2F2',
  dangerBorder: '#FECACA',
  success: '#16A34A',
  successTint: '#F0FDF4',
  warning: '#B45309',
  warningTint: '#FFFBEB',
} as const;

/** Chart / data-viz palette. */
export const CHART_COLORS = [
  '#1B4C82',
  '#3E7CB1',
  '#6FA3D8',
  '#9CC4E8',
  '#D7E6F7',
];

/** Staff avatar palette. */
export const AVATAR_COLORS = [
  '#1B4C82',
  '#3E7CB1',
  '#6B7280',
  '#123A66',
  '#9CA3AF',
];

export const SHADOWS = {
  card: '0 1px 3px rgba(16,40,80,0.06)',
  cardHover: '0 6px 16px rgba(16,40,80,0.12)',
  brand: '0 4px 12px rgba(27,76,130,0.28)',
  ink: '0 2px 8px rgba(0,0,0,0.18)',
  modal: '0 10px 25px rgba(16,40,80,0.16)',
} as const;

/** Brand identity fallbacks (real values come from /api/settings). */
export const BRAND = {
  name: 'Pure Milk',
  productName: 'Pure Milk POS',
} as const;

export default COLORS;
