import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import type { Metadata } from "next";
import { CitizenWalletPanel } from "@/components/citizens/citizen-wallet";
import { CitizenPortrait, MetadataFacts, MetadataName } from "@/components/citizens/portrait";
import { formatUtc, shortAddress, verificationLabel } from "@/lib/civilization/labels";
import { loadCitizenProfile } from "@/lib/civilization/load-profile";
import { loadCitizenWalletView } from "@/lib/wallets/load";
import { SourceBadge } from "@/components/world/event-item";
import { formatWorldTime } from "@/lib/world/clock";
import { loadCitizenMind } from "@/lib/ai/load-mind";
import { TRAIT_LABELS } from "@/lib/ai/personality";
import { loadCitizenWorld, loadEventPage } from "@/lib/world/load";
import { KIND_LABEL, ROLE_LABEL, citizenHref, describeCitizenNow } from "@/lib/world/present";

export const metadata: Metadata = {
  title: "Citizen",
};

const reserved = ["Social status", "Wealth", "Relationships"] as const;

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
  const wallet = await loadCitizenWalletView(citizen.citizenId);
  return (
    <div className="grid gap-8 lg:grid-cols-[18rem_minmax(0,1fr)]">
      <div className="portrait-frame aspect-square self-start overflow-hidden rounded-2xl border border-line">
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

        <CitizenInWorld tokenId={citizen.tokenId} />

        <CitizenMindSection tokenId={citizen.tokenId} />

        <CitizenHistory tokenId={citizen.tokenId} fallback={profile.events} />

        <CitizenWalletPanel view={wallet} />

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

async function CitizenInWorld({ tokenId }: { tokenId: string }) {
  const world = await loadCitizenWorld(tokenId);
  if (world.status !== "ok") {
    return (
      <section className="mt-8">
        <h2 className="font-serif text-2xl">In the world</h2>
        <p className="mt-2 text-sm leading-6 text-muted">{world.detail}</p>
      </section>
    );
  }
  const here = world.citizen;
  if (!here) {
    return (
      <section className="mt-8">
        <h2 className="font-serif text-2xl">In the world</h2>
        <p className="mt-2 text-sm leading-6 text-muted">
          This citizen has not entered the shared world. Only active founding and community citizens are placed there.
        </p>
      </section>
    );
  }
  const buildings = new Map(world.snapshot.buildings.map((b) => [b.id, b]));
  const home = here.homeId ? buildings.get(here.homeId) : undefined;
  const work = here.workId ? buildings.get(here.workId) : undefined;
  return (
    <section className="mt-8">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 className="font-serif text-2xl">In the world</h2>
        <Link href={citizenHref(tokenId)} className="text-sm text-accent">
          See on the map
        </Link>
      </div>
      <p className="mt-2">{describeCitizenNow(here, buildings)}</p>
      <dl className="mt-4 grid gap-4 sm:grid-cols-3">
        <div>
          <dt className="text-xs tracking-[0.14em] text-muted uppercase">Occupation</dt>
          <dd className="mt-1">{here.role ? ROLE_LABEL[here.role] : "Unassigned"}</dd>
          <dd className="mt-1 text-sm text-muted">{work ? `${work.name} · ${KIND_LABEL[work.kind]}` : "No workplace"}</dd>
        </div>
        <div>
          <dt className="text-xs tracking-[0.14em] text-muted uppercase">Home</dt>
          <dd className="mt-1">{home ? home.name : "Shelters at Commons Hall"}</dd>
        </div>
        <div>
          <dt className="text-xs tracking-[0.14em] text-muted uppercase">Decided by</dt>
          <dd className="mt-1">{here.decisionSource === "ai" ? "AI mind" : here.decisionSource === "system" ? "System" : "Simulation rules"}</dd>
          <dd className="mt-1 text-sm text-muted">
            {here.decisionSource === "ai"
              ? "This current activity was queued from a stored AI decision and revalidated by the simulation."
              : "Rules chose this activity. AI labels appear only after a model-backed runner submits a validated intent."}
          </dd>
        </div>
      </dl>
    </section>
  );
}

async function CitizenMindSection({ tokenId }: { tokenId: string }) {
  const mind = await loadCitizenMind(tokenId);
  if (mind.status !== "ok") {
    return (
      <section className="mt-8">
        <h2 className="font-serif text-2xl">Mind</h2>
        <p className="mt-2 text-sm leading-6 text-muted">{mind.detail}</p>
      </section>
    );
  }
  const data = mind.mind;
  const traits = data.personality
    ? (Object.entries(TRAIT_LABELS) as Array<[keyof typeof TRAIT_LABELS, string]>)
    : [];
  return (
    <section className="mt-8">
      <h2 className="font-serif text-2xl">Mind</h2>
      <p className="mt-2 text-sm leading-6 text-muted">
        {data.personalityOrigin === "deterministic"
          ? "Personality is a deterministic profile of this NFT identity. The hosted model is not trained on these rows."
          : "No personality has been initialized yet."}{" "}
        {data.aiActive ? "At least one AI decision is stored." : "No AI decision is stored for this citizen."}
      </p>
      {data.personality ? (
        <dl className="mt-4 grid gap-2 sm:grid-cols-2">
          {traits.map(([key, label]) => (
            <div key={key} className="rounded-xl border border-line px-3 py-3 text-sm">
              <dt className="text-muted">{label}</dt>
              <dd className="mt-1 tabular-nums">{data.personality![key]}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      <div className="mt-4 grid gap-4 sm:grid-cols-3">
        <div>
          <h3 className="text-xs tracking-[0.14em] text-muted uppercase">Skills</h3>
          {data.skills.length === 0 ? (
            <p className="mt-2 text-sm text-muted">Not recorded. Completing supported work can raise a skill.</p>
          ) : (
            <ul className="mt-2 text-sm">
              {data.skills.map((skill) => (
                <li key={skill.name}>
                  {skill.name} · {skill.level}/100
                </li>
              ))}
            </ul>
          )}
        </div>
        <div>
          <h3 className="text-xs tracking-[0.14em] text-muted uppercase">Goals</h3>
          {data.goals.length === 0 ? (
            <p className="mt-2 text-sm text-muted">Not recorded.</p>
          ) : (
            <ul className="mt-2 text-sm">
              {data.goals.slice(0, 4).map((goal) => (
                <li key={goal.id}>
                  {goal.title} · {goal.status} · {goal.progress}%
                </li>
              ))}
            </ul>
          )}
        </div>
        <div>
          <h3 className="text-xs tracking-[0.14em] text-muted uppercase">Memories</h3>
          {data.memories.length === 0 ? (
            <p className="mt-2 text-sm text-muted">Not recorded. Failures are not stored as successes.</p>
          ) : (
            <ul className="mt-2 text-sm">
              {data.memories.slice(0, 3).map((memory) => (
                <li key={memory.id}>
                  {memory.content}
                  {memory.outcome ? ` (${memory.outcome})` : ""}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </section>
  );
}

async function CitizenHistory({
  tokenId,
  fallback,
}: {
  tokenId: string;
  fallback: Array<{ id: string; summary: string; occurredAt: string; kind: string }>;
}) {
  const page = await loadEventPage({ tokenId }, null, 20);
  return (
    <section className="mt-8">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 className="font-serif text-2xl">History</h2>
        {page.status === "ok" ? (
          <Link href={`/activity?citizen=${tokenId}`} className="text-sm text-accent">
            Full history
          </Link>
        ) : null}
      </div>
      {page.status === "ok" ? (
        page.events.length === 0 ? (
          <p className="mt-2 text-sm leading-6 text-muted">
            No events recorded for this citizen yet. Rows appear as the simulation runs. None are invented.
          </p>
        ) : (
          <ul className="mt-3 divide-y divide-line border-y border-line">
            {page.events.map((event) => (
              <li key={event.id} className="flex items-start gap-3 py-3">
                <SourceBadge source={event.source} />
                <div className="min-w-0">
                  <p>{event.summary}</p>
                  <p className="mt-1 text-xs text-muted">
                    {event.worldS !== null ? `${formatWorldTime(event.worldS)} · ` : ""}
                    {formatUtc(event.occurredAt)} · {event.kind}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        )
      ) : fallback.length === 0 ? (
        <p className="mt-2 text-sm leading-6 text-muted">No life events recorded yet. None are simulated.</p>
      ) : (
        <ul className="mt-3 divide-y divide-line border-y border-line">
          {fallback.map((event) => (
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
  );
}
