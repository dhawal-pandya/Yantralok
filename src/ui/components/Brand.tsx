// The Yantralok mark + wordmark. The glyph is a tiny system diagram (a source
// fanning out to backends), the product in a badge. Phosphor amber is the accent.

export function BrandMark({ size = 24 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="0.6" y="0.6" width="22.8" height="22.8" rx="6.5" fill="#12161f" stroke="#f5b301" strokeOpacity="0.4" />
      <path
        d="M6.5 12 H11.5 M11.5 12 L17 7.5 M11.5 12 L17 16.5"
        stroke="#f5b301"
        strokeWidth="1.2"
        strokeOpacity="0.75"
        strokeLinecap="round"
      />
      <circle cx="6.5" cy="12" r="1.9" fill="#f5b301" />
      <circle cx="11.5" cy="12" r="1.9" fill="#f5b301" />
      <circle cx="17" cy="7.5" r="1.9" fill="#f5b301" />
      <circle cx="17" cy="16.5" r="1.9" fill="#f5b301" />
    </svg>
  );
}

/** "Made with ♥ by Dhawal Pandya", used in the footer and the hero. */
export function Credit({ className = "" }: { className?: string }) {
  return (
    <span className={`text-[11px] text-neutral-500 ${className}`}>
      Made with <span className="text-red-400">❤</span> by{" "}
      <a
        href="https://github.com/dhawal-pandya"
        target="_blank"
        rel="noreferrer"
        className="text-neutral-400 underline decoration-neutral-700 underline-offset-2 transition-colors hover:text-signal"
      >
        Dhawal Pandya
      </a>
    </span>
  );
}

export function Brand({
  size = 26,
  tagline = true,
}: {
  size?: number;
  tagline?: boolean;
}) {
  return (
    <div className="flex items-center gap-2.5 select-none">
      <BrandMark size={size} />
      <div className="flex flex-col leading-none">
        <span className="font-display font-semibold tracking-tight text-neutral-100" style={{ fontSize: size * 0.62 }}>
          Yantralok
        </span>
        {tagline && (
          <span className="mt-0.5 font-mono uppercase tracking-[0.22em] text-neutral-500" style={{ fontSize: Math.max(7, size * 0.3) }}>
            systems simulator
          </span>
        )}
      </div>
    </div>
  );
}
