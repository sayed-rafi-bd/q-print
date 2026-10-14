import { useState } from 'react';

/**
 * Cute little printer mascot. It bounces, blinks, wiggles when hovered and shakes while a job
 * is being sent. Clicking it makes it squeal with a heart. All motion is CSS (see index.css).
 */
export function Mascot({ busy = false, className = '' }: { busy?: boolean; className?: string }) {
  const [hearts, setHearts] = useState(0);
  return (
    <button type="button" aria-label="Q-Print mascot" onClick={() => setHearts(h => h + 1)}
            className={'relative inline-block shrink-0 rounded-3xl focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-300 ' + className}>
      <svg viewBox="0 0 120 104" className={'mascot h-16 w-[4.6rem] overflow-visible ' + (busy ? 'is-busy' : '')} aria-hidden="true">
        {/* sparkles */}
        <path className="sparkle" d="M10 18l2.4 5.6L18 26l-5.6 2.4L10 34l-2.4-5.6L2 26l5.6-2.4z" fill="#ffd166" />
        <path className="sparkle" d="M108 8l1.8 4.2L114 14l-4.2 1.8L108 20l-1.8-4.2L102 14l4.2-1.8z" fill="#9ad8ff" />
        <path className="sparkle" d="M112 60l1.6 3.6L117 65l-3.4 1.4L112 70l-1.6-3.6L107 65l3.4-1.4z" fill="#ffb3d9" />

        {/* paper coming out of the top */}
        <g className="paper">
          <rect x="34" y="6" width="52" height="34" rx="4" fill="#fff" stroke="#e8b8d6" strokeWidth="2" />
          <path d="M60 28c-5-3.6-9-6.4-9-10a4.6 4.6 0 019-1.4A4.6 4.6 0 0169 18c0 3.6-4 6.4-9 10z" fill="#ff8cc4" />
        </g>

        {/* body */}
        <rect x="12" y="34" width="96" height="52" rx="18" fill="#ffc2dd" stroke="#f4589f" strokeWidth="3" />
        <rect x="12" y="34" width="96" height="14" rx="14" fill="#ffd9ea" />
        {/* tray */}
        <rect x="28" y="78" width="64" height="16" rx="6" fill="#fff" stroke="#f4589f" strokeWidth="3" />
        <rect x="38" y="84" width="44" height="3" rx="1.5" fill="#ffc2dd" />

        {/* face */}
        <ellipse className="eye" cx="44" cy="60" rx="5" ry="6.5" fill="#55446a" />
        <ellipse className="eye" cx="76" cy="60" rx="5" ry="6.5" fill="#55446a" />
        <circle cx="46" cy="57.6" r="1.8" fill="#fff" />
        <circle cx="78" cy="57.6" r="1.8" fill="#fff" />
        <ellipse cx="33" cy="68" rx="6" ry="3.6" fill="#ff8cc4" opacity="0.7" />
        <ellipse cx="87" cy="68" rx="6" ry="3.6" fill="#ff8cc4" opacity="0.7" />
        {busy
          ? <ellipse cx="60" cy="69" rx="4" ry="4.4" fill="#55446a" />
          : <path d="M53 66q7 8 14 0" fill="none" stroke="#55446a" strokeWidth="3" strokeLinecap="round" />}
      </svg>

      {/* a heart floats up for every click */}
      {hearts > 0 && (
        <span key={hearts} aria-hidden="true"
              className="pointer-events-none absolute left-1/2 top-0 text-lg"
              style={{
                animation: 'confetti-burst 1.1s ease-out forwards',
                ['--x' as string]: '0px', ['--y' as string]: '-46px', ['--r' as string]: '12deg',
              } as React.CSSProperties}>
          💖
        </span>
      )}
    </button>
  );
}

const PIECES = ['🎀', '✨', '💖', '⭐', '🌸', '💫', '🎉', '💕', '✨', '🌈', '💖', '🎀'];

/** One-shot burst of sparkles; mount it when something succeeds (remount with a new `key` to replay). */
export function Confetti() {
  return (
    <div className="confetti" aria-hidden="true">
      {PIECES.map((p, i) => {
        const angle = (i / PIECES.length) * Math.PI * 2;
        const dist = 70 + (i % 3) * 28;
        return (
          <i key={i}
             style={{
               ['--x' as string]: `${Math.round(Math.cos(angle) * dist)}px`,
               ['--y' as string]: `${Math.round(Math.sin(angle) * dist - 30)}px`,
               ['--r' as string]: `${(i % 2 ? 1 : -1) * (40 + i * 18)}deg`,
               ['--d' as string]: `${(i % 4) * 0.05}s`,
             } as React.CSSProperties}>
            {p}
          </i>
        );
      })}
    </div>
  );
}
