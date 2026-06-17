/**
 * Approximate brand marks for the agents known to work with this storefront.
 * These are simple representative glyphs, not official trademark assets.
 */

export function ClaudeLogo() {
  // Anthropic / Claude — stylized starburst spark.
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" role="img" focusable="false">
      <path
        fill="currentColor"
        d="M12 2l1.7 6.1L19 5.2l-3.1 5L22 12l-6.1 1.7L19 18.8l-5-3.1L12 22l-1.7-6.1L5 18.8l3.1-5L2 12l6.1-1.7L5 5.2l5 3.1L12 2z"
      />
    </svg>
  );
}

export function CodexLogo() {
  // OpenAI Codex — interlocking knot, approximated by a six-fold rosette ring.
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" role="img" focusable="false">
      <g fill="none" stroke="currentColor" strokeWidth="1.6">
        <circle cx="12" cy="12" r="6.4" />
        <circle cx="12" cy="12" r="2.4" />
        <path d="M12 5.6V2.6M12 21.4v-3M5.6 12H2.6M21.4 12h-3M7.5 7.5L5.4 5.4M18.6 18.6l-2.1-2.1M16.5 7.5l2.1-2.1M5.4 18.6l2.1-2.1" />
      </g>
    </svg>
  );
}

export function HermesLogo() {
  // Hermes — winged caduceus, approximated by a winged staff glyph.
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" role="img" focusable="false">
      <g fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
        <path d="M12 4v16" />
        <path d="M12 6c-2.5-2-5-2.4-7.5-1.5C6 7 8 8.2 12 8.2 16 8.2 18 7 19.5 4.5 17 3.6 14.5 4 12 6z" />
        <path d="M9 12c1 1.2 1 3-1 4M15 12c-1 1.2-1 3 1 4" />
        <circle cx="12" cy="3" r="1.3" fill="currentColor" stroke="none" />
      </g>
    </svg>
  );
}

export function OpenClawLogo() {
  // OpenClaw — three-tine claw mark.
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" role="img" focusable="false">
      <g fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
        <path d="M6 3.5c-1.5 4 0 9 2.5 12.5" />
        <path d="M12 2.5c-1 4.5-1 9.5 0 13.5" />
        <path d="M18 3.5c1.5 4 0 9-2.5 12.5" />
        <path d="M7 17.5c1.5 2.5 3.2 3.7 5 3.7s3.5-1.2 5-3.7" />
      </g>
    </svg>
  );
}
