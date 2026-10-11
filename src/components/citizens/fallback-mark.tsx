export function hueForToken(tokenId: string): number {
  let hash = 0;
  for (const char of tokenId) {
    hash = (hash * 33 + char.charCodeAt(0)) >>> 0;
  }
  return 142 + (hash % 36);
}

export function FallbackMark({ tokenId }: { tokenId: string }) {
  const hue = hueForToken(tokenId);
  return (
    <svg
      data-testid="citizen-fallback"
      viewBox="0 0 160 200"
      role="img"
      aria-label={`Chog Genesis ${tokenId} artwork unavailable`}
      className="h-full w-full"
    >
      <rect width="160" height="200" fill={`hsl(${hue} 28% 10%)`} />
      <circle cx="80" cy="78" r="36" fill={`hsl(${hue} 70% 62%)`} opacity="0.9" />
      <circle cx="68" cy="74" r="4" fill="#07110e" />
      <circle cx="92" cy="74" r="4" fill="#07110e" />
      <path d="M68 88 Q80 96 92 88" fill="none" stroke="#07110e" strokeWidth="2" />
      <text x="80" y="156" textAnchor="middle" fill="#d7fff0" fontSize="16">
        #{tokenId}
      </text>
    </svg>
  );
}
