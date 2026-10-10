/* eslint-disable @next/next/no-html-link-for-pages -- These anchors are SVG elements. next/link would emit HTML anchors and leave the scene. */

type SceneProps = {
  foundingCount: number | null;
  communityCount: number | null;
  treasuryCount: number | null;
};

function countText(value: number | null): string {
  return value === null ? "—" : String(value);
}

export function CivilizationScene({ foundingCount, communityCount, treasuryCount }: SceneProps) {
  return (
    <svg
      viewBox="0 0 960 640"
      role="img"
      aria-label="chogOS civilization"
      className="h-auto w-full"
    >
      <title>chogOS civilization</title>
      <defs>
        <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#101820" />
          <stop offset="55%" stopColor="#0b1214" />
          <stop offset="100%" stopColor="#07110e" />
        </linearGradient>
        <linearGradient id="ground" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#16342c" />
          <stop offset="100%" stopColor="#07110e" />
        </linearGradient>
        <radialGradient id="beacon" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#d9ffe9" />
          <stop offset="40%" stopColor="#3dffb0" />
          <stop offset="100%" stopColor="#3dffb0" stopOpacity="0" />
        </radialGradient>
        <filter id="soft-glow" x="-40%" y="-40%" width="180%" height="180%">
          <feGaussianBlur stdDeviation="8" />
        </filter>
      </defs>

      <rect width="960" height="640" fill="url(#sky)" />
      <path d="M0 250 C160 210 280 280 430 230 C590 176 700 250 960 190 L960 640 L0 640 Z" fill="#0c1916" />
      <path d="M0 340 C180 300 320 390 520 330 C700 278 820 360 960 300 L960 640 L0 640 Z" fill="url(#ground)" />
      <path d="M80 470 C240 450 300 500 470 478 C650 454 760 510 900 470" fill="none" stroke="#1f6d55" strokeWidth="2" opacity="0.7" />

      {[
        [120, 90, 0],
        [210, 140, 1.2],
        [760, 70, 0.6],
        [840, 150, 1.8],
        [640, 110, 2.4],
        [380, 80, 1],
      ].map(([x, y, delay]) => (
        <circle
          key={`${x}-${y}`}
          className="chog-mote"
          cx={x}
          cy={y}
          r="2.2"
          fill="#9cf6cf"
          style={{ animationDelay: `${delay}s` }}
        />
      ))}

      <a href="/activity" className="civic-link" aria-label="History district">
        <Building x={92} y={430} w={150} depth={54} height={120} body="#10241f" roof="#1a3b32" />
        <WindowRow x={112} y={360} />
        <WindowRow x={112} y={392} />
        <text x="168" y="458" textAnchor="middle" fill="#d7fff0" fontSize="15">
          Archive
        </text>
      </a>

      <a href="/citizens" className="civic-link" aria-label="Citizens district">
        <Building x={690} y={438} w={168} depth={60} height={138} body="#121c28" roof="#24344a" />
        <WindowRow x={712} y={352} tone="#b7a6ff" />
        <WindowRow x={712} y={386} tone="#b7a6ff" />
        <text x="776" y="466" textAnchor="middle" fill="#d7fff0" fontSize="15">
          Citizens
        </text>
      </a>

      <g aria-label="Capital">
        <Building x={360} y={470} w={210} depth={78} height={210} body="#102820" roof="#1d4a3c" />
        <polygon points="465,150 430,250 500,250" fill="#16382e" />
        <polygon points="500,250 500,150 545,188" fill="#0c241c" />
        <circle cx="478" cy="168" r="28" fill="url(#beacon)" filter="url(#soft-glow)" />
        <circle cx="470" cy="166" r="3" fill="#07110e" />
        <circle cx="486" cy="166" r="3" fill="#07110e" />
        <path d="M468 176 Q478 182 488 176" fill="none" stroke="#07110e" strokeWidth="1.5" />
        <WindowRow x={392} y={300} />
        <WindowRow x={392} y={340} />
        <WindowRow x={392} y={380} />
        <text x="468" y="500" textAnchor="middle" fill="#e8fff6" fontSize="18">
          Capital
        </text>
      </g>

      <a href="/treasury" className="civic-link" aria-label="Treasury landmark">
        <Building x={250} y={545} w={130} depth={46} height={78} body="#123028" roof="#39f0b0" />
        <rect x="292" y="490" width="28" height="40" rx="2" fill="#07110e" />
        <circle cx="314" cy="470" r="16" fill="#3dffb0" opacity="0.85" />
        <text x="318" y="572" textAnchor="middle" fill="#d7fff0" fontSize="14">
          Genesis vault
        </text>
      </a>

      <a href="/enroll" className="civic-link" aria-label="Enrollment gate">
        <Building x={620} y={548} w={120} depth={42} height={70} body="#171427" roof="#3a2d58" />
        <rect x="658" y="500" width="34" height="36" fill="#0b1020" />
        <path d="M658 500 L675 484 L692 500" fill="none" stroke="#a78bfa" strokeWidth="2" />
        <text x="682" y="574" textAnchor="middle" fill="#d7fff0" fontSize="14">
          Gate
        </text>
      </a>

      <g>
        <text x="48" y="78" fill="#93a89f" fontSize="13" letterSpacing="2">
          SHARED WORLD
        </text>
        <text x="48" y="112" fill="#e8f7f0" fontSize="32">
          {countText(foundingCount)} founding
        </text>
        <text x="48" y="140" fill="#c8b6ff" fontSize="18">
          {countText(communityCount)} community
        </text>
        <text x="48" y="168" fill="#3dffb0" fontSize="16">
          {countText(treasuryCount)} treasury NFTs
        </text>
      </g>
    </svg>
  );
}

function Building({
  x,
  y,
  w,
  depth,
  height,
  body,
  roof,
}: {
  x: number;
  y: number;
  w: number;
  depth: number;
  height: number;
  body: string;
  roof: string;
}) {
  const dx = depth * 0.62;
  const dy = depth * 0.36;
  return (
    <g>
      <polygon points={`${x},${y} ${x + w},${y} ${x + w},${y - height} ${x},${y - height}`} fill={body} />
      <polygon
        points={`${x + w},${y} ${x + w + dx},${y - dy} ${x + w + dx},${y - height - dy} ${x + w},${y - height}`}
        fill="#091410"
      />
      <polygon
        points={`${x},${y - height} ${x + w},${y - height} ${x + w + dx},${y - height - dy} ${x + dx},${y - height - dy}`}
        fill={roof}
      />
    </g>
  );
}

function WindowRow({ x, y, tone = "#8ef6c8" }: { x: number; y: number; tone?: string }) {
  return (
    <g>
      {[0, 28, 56, 84].map((offset) => (
        <rect key={offset} x={x + offset} y={y} width="12" height="16" rx="1" fill={tone} opacity="0.85" />
      ))}
    </g>
  );
}
