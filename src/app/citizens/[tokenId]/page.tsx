import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import type { Metadata } from "next";
import { CitizenPortrait, MetadataFacts, MetadataName } from "@/components/citizens/portrait";
import { formatUtc, shortAddress, verificationLabel } from "@/lib/civilization/labels";
import { loadCitizenProfile } from "@/lib/civilization/load-profile";

export const metadata: Metadata = {
  title: "Citizen",
};

const reserved = [
  "Occupation",
  "Skills",
  "Social status",
  "Wealth",
  "Relationships",
  "Goals",
  "AI memory",
  "Personal wallet",
] as const;

export default function CitizenPage({ params }: { params: Promise<{ tokenId: string }> }) {
  return (
    <Suspense fallback={<p className="text-sm text-muted">Opening citizen…</p>}>
      {params.then(({ tokenId }) => (
        <CitizenLive tokenId={tokenId} />
      ))}
    </Suspense>
  );
}

async function CitizenLive({ tokenId }: { tokenId: string }) {
  await connection();
  const profile = await loadCitizenProfile(tokenId);

  if (profile.status === "invalid") {
    return <p className="text-sm text-warning">{profile.reason}</p>;
  }

  if (profile.status === "missing") {
    return (
      <div className="max-w-2xl">
        <h1 className="font-serif text-4xl">Token {profile.tokenId}</h1>
        <p className="mt-3 text-sm leading-6 text-muted">
          ownerOf did not return an owner. This token may not be a current Chog Genesis NFT, or the RPC call
          failed. {profile.note}
        </p>
      </div>
    );
  }

  if (profile.status === "unenrolled") {
    return (
      <div className="max-w-2xl">
        <h1 className="font-serif text-4xl">Chog #{profile.tokenId}</h1>
        <p className="mt-3 text-sm leading-6 text-muted">{profile.note}</p>
        <p className="mt-3 font-mono text-xs break-all text-muted">Current owner {profile.owner}</p>
        {profile.heldByTreasury ? (
          <p className="mt-3 text-sm text-muted">Held by ChogTreasury. This is not a personal wallet.</p>
        ) : (
          <Link href="/enroll" className="mt-4 inline-block text-sm text-accent">
            Enroll this NFT
          </Link>
        )}
      </div>
    );
  }

  const citizen = profile.citizen;
  return (
    <div className="grid gap-8 lg:grid-cols-[18rem_minmax(0,1fr)]">
      <div className="portrait-frame overflow-hidden rounded-2xl border border-line">
        <CitizenPortrait tokenId={citizen.tokenId} name={citizen.metadataName} />
      </div>
      <div>
        <p className="text-xs tracking-[0.16em] text-accent uppercase">{citizen.designation}</p>
        <h1 className="mt-2 font-serif text-5xl tracking-tight">
          <MetadataName tokenId={citizen.tokenId} fallback={citizen.metadataName ?? `Chog #${citizen.tokenId}`} />
        </h1>
        <p className="mt-3 text-sm text-muted">Token {citizen.tokenId} · chogOS</p>
        <dl className="mt-6 grid gap-4 sm:grid-cols-2">
          <div>
            <dt className="text-xs tracking-[0.14em] text-muted uppercase">Current owner</dt>
            <dd className="mt-1 font-mono text-xs break-all">
              {profile.chainOwner ? profile.chainOwner : "ownerOf did not return"}
            </dd>
            <dd className="mt-1 text-sm text-muted">{profile.ownerNote}</dd>
          </div>
          <div>
            <dt className="text-xs tracking-[0.14em] text-muted uppercase">Enrollment</dt>
            <dd className="mt-1">{citizen.enrollmentStatus}</dd>
            <dd className="mt-1 text-sm text-muted">{verificationLabel(citizen.verification)}</dd>
          </div>
          <div>
            <dt className="text-xs tracking-[0.14em] text-muted uppercase">History reference</dt>
            <dd className="mt-1 font-mono text-xs break-all">{citizen.citizenId ?? "Not persisted"}</dd>
          </div>
          <div>
            <dt className="text-xs tracking-[0.14em] text-muted uppercase">Stored owner snapshot</dt>
            <dd className="mt-1 font-mono text-xs break-all">
              {citizen.owner ? shortAddress(citizen.owner) : "None"}
            </dd>
          </div>
        </dl>
        {profile.heldByTreasury ? (
          <p className="mt-4 text-sm leading-6 text-muted">
            Held by ChogTreasury ({shortAddress(profile.treasury)}). No external wallet controls this founding
            citizen while the treasury holds the NFT.
          </p>
        ) : null}

        <section className="mt-8">
          <h2 className="font-serif text-2xl">History</h2>
          {profile.events.length === 0 ? (
            <p className="mt-2 text-sm leading-6 text-muted">
              No life events yet. Future AI decisions will appear here. None are simulated.
            </p>
          ) : (
            <ul className="mt-3 divide-y divide-line border-y border-line">
              {profile.events.map((event) => (
                <li key={event.id} className="py-3">
                  <p>{event.summary}</p>
                  <p className="mt-1 text-xs text-muted">
                    {formatUtc(event.occurredAt)} · {event.kind}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="mt-8">
          <h2 className="font-serif text-2xl">Collection traits</h2>
          <div className="mt-3">
            <MetadataFacts tokenId={citizen.tokenId} />
          </div>
        </section>

        <section className="mt-8">
          <h2 className="font-serif text-2xl">Reserved attributes</h2>
          <ul className="mt-3 grid gap-2 sm:grid-cols-2">
            {reserved.map((item) => (
              <li key={item} className="rounded-xl border border-line px-3 py-3 text-sm">
                <span className="text-muted">{item}</span>
                <span className="mt-1 block">Not recorded</span>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  );
}
