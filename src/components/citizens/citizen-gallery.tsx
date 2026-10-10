import Link from "next/link";
import { CitizenPortrait, MetadataName } from "@/components/citizens/portrait";
import { shortAddress, verificationLabel } from "@/lib/civilization/labels";
import type { DisplayCitizen } from "@/lib/civilization/roster";

export function CitizenGallery({ citizens }: { citizens: DisplayCitizen[] }) {
  if (citizens.length === 0) {
    return (
      <p className="text-sm leading-6 text-muted">
        No verified citizens to show. A treasury read has not returned token ids, and no roster is stored.
      </p>
    );
  }

  return (
    <ul className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
      {citizens.map((citizen) => (
        <li key={citizen.tokenId} className="overflow-hidden rounded-2xl border border-line bg-card">
          <Link href={`/citizens/${citizen.tokenId}`} className="block focus-visible:outline-2 focus-visible:outline-accent">
            <div className="portrait-frame aspect-[4/5]">
              <CitizenPortrait tokenId={citizen.tokenId} name={citizen.metadataName} />
            </div>
            <div className="space-y-1 px-3 py-3">
              <p className="font-serif text-xl tracking-tight">
                <MetadataName tokenId={citizen.tokenId} fallback={citizen.metadataName ?? `Chog #${citizen.tokenId}`} />
              </p>
              <p className="text-xs tracking-[0.14em] text-accent uppercase">Token {citizen.tokenId}</p>
              <p className="text-sm text-foreground">{citizen.designation}</p>
              <p className="text-xs leading-5 text-muted">{verificationLabel(citizen.verification)}</p>
              <p className="font-mono text-xs text-muted">
                {citizen.owner ? shortAddress(citizen.owner) : "Owner not recorded"}
              </p>
            </div>
          </Link>
        </li>
      ))}
    </ul>
  );
}
