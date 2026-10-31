// Inline SVG icons. Status glyphs are shape-coded (ring, pie, disc + mark) so
// color is never the only signal; ink colors come from CSS (.ink / .ink-f),
// because presentation attributes cannot resolve var().
import type { JSX } from 'preact';

export type GlyphKind = 'blocked' | 'question' | 'working' | 'stale' | 'done' | 'idle' | 'error' | 'ended';

const disc = <circle cx="7" cy="7" r="6" fill="currentColor" />;
const ring = (dash?: string) => (
  <circle cx="7" cy="7" r="5.25" fill="none" stroke="currentColor" stroke-width="1.5" stroke-dasharray={dash} />
);
const check = <path class="ink" d="M4.4 7.15l1.75 1.75L9.6 5.4" stroke-width="1.5" />;

// Created once; Preact clones reused vnodes, so sharing them is safe.
const GLYPHS: Record<GlyphKind, JSX.Element> = {
  idle: ring(),
  working: (
    <>
      {ring()}
      <g class="si-spin">
        <path d="M7 3.5A3.5 3.5 0 0 1 7 10.5Z" fill="currentColor" />
      </g>
    </>
  ),
  stale: (
    <>
      {ring('2.1 2')}
      <path d="M7 3.5A3.5 3.5 0 0 1 10.5 7H7Z" fill="currentColor" />
    </>
  ),
  blocked: (
    <>
      {disc}
      <path class="ink" d="M7 4v3.4" stroke-width="1.6" />
      <circle class="ink-f" cx="7" cy="9.9" r=".9" />
    </>
  ),
  question: (
    <>
      {disc}
      <path class="ink" d="M5.35 5.5a1.7 1.7 0 1 1 2.35 1.55c-.45.2-.7.55-.7 1v.2" stroke-width="1.4" />
      <circle class="ink-f" cx="7" cy="10.1" r=".85" />
    </>
  ),
  done: (
    <>
      {disc}
      {check}
    </>
  ),
  error: (
    <>
      {disc}
      <path class="ink" d="M5.1 5.1l3.8 3.8M8.9 5.1L5.1 8.9" stroke-width="1.5" />
    </>
  ),
  ended: (
    <>
      {disc}
      <path class="ink" d="M4.6 7h4.8" stroke-width="1.5" />
    </>
  ),
};

export function StatusIcon({ kind, size = 14 }: { kind: GlyphKind; size?: number }) {
  return (
    <svg class={`si si-${kind}`} width={size} height={size} viewBox="0 0 14 14" aria-hidden="true" focusable="false">
      {GLYPHS[kind]}
    </svg>
  );
}

export function Logo({ size = 18 }: { size?: number }) {
  return (
    <svg class="logo" width={size} height={size} viewBox="0 0 18 18" aria-hidden="true" focusable="false">
      <rect width="18" height="18" rx="5" fill="currentColor" />
      <rect class="logo-cell" x="5" y="5" width="3" height="3" rx="1" />
      <rect class="logo-cell-on" x="10" y="5" width="3" height="3" rx="1" />
      <rect class="logo-cell" x="5" y="10" width="3" height="3" rx="1" />
      <rect class="logo-cell" x="10" y="10" width="3" height="3" rx="1" />
    </svg>
  );
}

export function Chevron() {
  return (
    <svg class="chev" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" focusable="false">
      <path d="M4.5 3l3 3-3 3" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  );
}

export function SignOut() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true" focusable="false">
      <path
        d="M8.5 2.5h2a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1h-2M5.5 4.5L3 7l2.5 2.5M3 7h6.5"
        fill="none"
        stroke="currentColor"
        stroke-width="1.3"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </svg>
  );
}

const themeStroke = {
  fill: 'none',
  stroke: 'currentColor',
  'stroke-width': 1.3,
  'stroke-linecap': 'round',
  'stroke-linejoin': 'round',
} as const;

/** Monitor (follow system), sun (light) or moon (dark). */
export function ThemeIcon({ pref }: { pref: 'system' | 'light' | 'dark' }) {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true" focusable="false">
      {pref === 'system' && (
        <>
          <rect x="1.75" y="2.5" width="10.5" height="7" rx="1.25" {...themeStroke} />
          <path d="M5 11.75h4M7 9.5v2.25" {...themeStroke} />
        </>
      )}
      {pref === 'light' && (
        <>
          <circle cx="7" cy="7" r="2.4" {...themeStroke} />
          <path
            d="M7 1.4v1.3M7 11.3v1.3M1.4 7h1.3M11.3 7h1.3M3.04 3.04l.92.92M10.04 10.04l.92.92M3.04 10.96l.92-.92M10.04 3.96l.92-.92"
            {...themeStroke}
          />
        </>
      )}
      {pref === 'dark' && <path d="M11.6 8.6A4.9 4.9 0 0 1 5.4 2.4a4.9 4.9 0 1 0 6.2 6.2Z" {...themeStroke} />}
    </svg>
  );
}
