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
