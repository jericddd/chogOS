"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { AiRunView } from "@/lib/ai/run-record";
import type { ChogBankPublicView } from "@/lib/economy/treasury-public";
import type { LinkState, RealtimeState } from "@/components/world/live-store";
import { useNow } from "@/components/world/use-now";
import { formatWorldTime, runnerHealth, worldSecondsAt } from "@/lib/world/clock";
import {
  aiMindLabel,
  bankStatusLabel,
  constructionSites,
  roadsIndicator,
  townDevelopment,
  townNeedsIndicator,
  type BankDeploymentState,
} from "@/lib/world/civilization-status";
import { ACTIVITY_LABEL, citizenLabel } from "@/lib/world/present";
import type { Selection } from "@/components/world/world-canvas";
import type { WorldActivity, WorldSnapshot } from "@/lib/world/types";

const HEALTH_LABEL = {
  live: "Live",
  delayed: "Delayed",
  stalled: "Runner stopped",
  paused: "Paused",
} as const;

function Icon({ children }: { children: React.ReactNode }) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden className="h-4 w-4 shrink-0 fill-current">
      {children}
    </svg>
  );
}

function ConstructionIcon() {
  return (
    <Icon>
      <path d="M2 13h12v2H2zM3 12l5-9 2 1-4 8zM9 3l4 2-1 2-4-2z" />
    </Icon>
  );
}

function CitizensIcon() {
  return (
    <Icon>
      <path d="M6 2h4v4H6zM3 8h10v2H3zM4 11h3v3H4zM9 11h3v3H9z" />
    </Icon>
  );
}

function TownIcon() {
  return (
    <Icon>
      <path d="M2 8h4V4h4v4h4v6H2zM4 10h2v2H4zM8 10h2v2H8z" />
    </Icon>
  );
}

function MindIcon() {
  return (
    <Icon>
      <path d="M3 4h10v8H3zM5 6h2v2H5zM9 6h2v2H9zM5 10h6v1H5z" />
    </Icon>
  );
}

function BankIcon() {
  return (
    <Icon>
      <path d="M2 6h12v2H2zM3 3h10l-5 3zM3 9h2v4H3zM7 9h2v4H7zM11 9h2v4h-2zM2 13h12v1H2z" />
    </Icon>
  );
}

function NeedsIcon() {
  return (
    <Icon>
      <path d="M3 3h4v4H3zM9 3h4v4H9zM3 9h4v4H3zM9 9h4v4H9z" />
    </Icon>
  );
}

function RoadsIcon() {
  return (
    <Icon>
      <path d="M2 4h12v2H2zM2 10h12v2H2zM7 2h2v12H7z" />
    </Icon>
  );
}

function Meter({ value }: { value: number }) {
  const width = Math.max(0, Math.min(100, value));
  return (
    <div className="mt-1 h-1.5 w-full bg-line" role="progressbar" aria-valuenow={value} aria-valuemin={0} aria-valuemax={100}>
      <div className="h-full bg-accent" style={{ width: `${width}%` }} />
    </div>
  );
}

function Row({
  icon,
  label,
  value,
  href,
  onClick,
  title,
  children,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  href?: string;
  onClick?: () => void;
  title?: string;
  children?: React.ReactNode;
}) {
  const className =
    "block w-full border-2 border-line bg-background/80 px-2 py-1.5 text-left text-foreground hover:border-[var(--pixel-gold)]";
  const body = (
    <>
      <span className="flex items-center gap-2">
        <span className="text-accent">{icon}</span>
        <span className="min-w-0 flex-1">
          <span className="block font-display text-[0.5rem] leading-4 tracking-wide text-muted uppercase">{label}</span>
          <span className="block truncate text-xs leading-4">{value}</span>
        </span>
      </span>
      {children}
    </>
  );
  if (href) {
    return (
      <Link href={href} className={className} title={title}>
        {body}
      </Link>
    );
  }
  if (onClick) {
    return (
      <button type="button" onClick={onClick} className={className} title={title}>
        {body}
      </button>
    );
  }
  return (
    <div className={className} title={title}>
      {body}
    </div>
  );
}

export function CivilizationStatus({
  snapshot,
  aiRun,
  skewMs,
  link,
  realtime,
  onPick,
}: {
  snapshot: WorldSnapshot;
  aiRun: AiRunView;
  skewMs: number;
  link: LinkState;
  realtime: RealtimeState;
  onPick: (selection: Selection) => void;
}) {
  const now = useNow(1_000);
  const serverNow = now > 0 ? now + skewMs : Date.parse(snapshot.clock.serverNow);
  const worldS = worldSecondsAt(snapshot.clock, serverNow);
  const health = runnerHealth(snapshot.clock, serverNow);
  const sites = constructionSites(snapshot.buildings);
  const development = townDevelopment(snapshot.townProjects ?? [], snapshot.townProjectsReady ?? false);
  const needs = townNeedsIndicator(snapshot.townNeeds ?? [], snapshot.townNeedsReady ?? false);
  const roads = roadsIndicator(snapshot.roads ?? [], snapshot.roadsReady ?? false);
  const registered = snapshot.citizens.length;
  const constructionId =
    sites.measured[0]?.id ?? snapshot.buildings.find((building) => building.status === "under_construction")?.id;
  const roadId = roads.roadId;
  const [bank, setBank] = useState<BankDeploymentState | "loading" | "unread">("loading");
  const [bankTitle, setBankTitle] = useState("Reading the public ChogBank check.");

  useEffect(() => {
    let cancelled = false;
    fetch("/api/economy/bank", { cache: "no-store" })
      .then(async (response) => {
        const body = (await response.json()) as { ok?: boolean; view?: ChogBankPublicView; reason?: string };
        if (cancelled) return;
        if (!response.ok || !body.ok || !body.view) {
          setBank("unread");
          setBankTitle(body.reason ?? "The public books could not be read.");
          return;
        }
        setBank(body.view.deploymentState);
        setBankTitle(body.view.summary);
      })
      .catch(() => {
        if (!cancelled) {
          setBank("unread");
          setBankTitle("The public books could not be read.");
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const constructionValue = sites.count === 0 ? "None active" : `${sites.count} active`;
  const developmentValue =
    development.kind === "untracked"
      ? "Not tracked"
      : development.kind === "none"
        ? "No open project"
        : development.kind === "steps"
          ? `${development.completed}/${development.total} steps`
          : development.status;
  const sortedCitizens = [...snapshot.citizens].sort((a, b) => Number(a.tokenId) - Number(b.tokenId));

  return (
    <section aria-label="Civilization status" className="space-y-1.5">
      <p className="font-display text-[0.55rem] leading-4 text-accent">Civilization</p>
      <p className="text-xs leading-4 text-muted tabular-nums" title={HEALTH_LABEL[health]}>
        {formatWorldTime(worldS)} · {HEALTH_LABEL[health]}
        {link === "live" ? "" : ` · ${link}`}
        {realtime === "error" ? " · polling" : ""}
      </p>
      <Row
        icon={<ConstructionIcon />}
        label="Construction"
        value={constructionValue}
        href={constructionId ? undefined : "/activity?category=construction"}
        onClick={constructionId ? () => onPick({ type: "building", id: constructionId }) : undefined}
        title={sites.unmeasured > 0 ? `${sites.unmeasured} site${sites.unmeasured === 1 ? "" : "s"} have no stored progress.` : "Stored construction progress."}
      >
        {sites.measured.slice(0, 2).map((site) => (
          <span key={site.id} className="mt-1 block">
            <span className="text-[0.65rem] leading-4 text-muted">
              {site.name} · {site.progress}%
            </span>
            <Meter value={site.progress} />
          </span>
        ))}
      </Row>
      <Row icon={<CitizensIcon />} label="Citizens" value={`${registered} registered`} href="/citizens" title="Citizens currently in the world roster." />
      <Row icon={<NeedsIcon />} label="Town needs" value={needs.value} title={needs.title} />
      <Row
        icon={<RoadsIcon />}
        label="Roads"
        value={roads.value}
        title={roads.title}
        onClick={roadId ? () => onPick({ type: "road", id: roadId }) : undefined}
      />
      <Row
        icon={<TownIcon />}
        label="Town development"
        value={development.kind === "steps" || development.kind === "status" ? `${development.name} · ${developmentValue}` : developmentValue}
        href={development.kind === "steps" || development.kind === "status" ? undefined : "/activity#town-growth"}
        onClick={
          development.kind === "steps" || development.kind === "status"
            ? () => onPick({ type: "project", id: development.projectId })
            : undefined
        }
        title={development.kind === "untracked" ? "Town projects are not in this database yet." : "Progress follows stored project steps."}
      >
        {development.kind === "steps" ? <Meter value={(development.completed / development.total) * 100} /> : null}
      </Row>
      <Row
        icon={<MindIcon />}
        label="AI mind"
        value={aiMindLabel(aiRun.state)}
        href="/activity#civilization-activity"
        title={aiRun.detail}
      />
      <Row icon={<BankIcon />} label="ChogBank" value={bankStatusLabel(bank)} href="/economy" title={bankTitle} />
      <label className="block text-[0.65rem] text-muted">
        Find a citizen
        <select
          className="mt-1 block w-full border-2 border-line bg-background px-1.5 py-1 text-xs text-foreground"
          value=""
          onChange={(event) => event.target.value && onPick({ type: "citizen", tokenId: event.target.value })}
        >
          <option value="">Choose…</option>
          {sortedCitizens.map((citizen) => (
            <option key={citizen.tokenId} value={citizen.tokenId}>
              {citizenLabel(citizen)} · {ACTIVITY_LABEL[citizen.activity as WorldActivity]}
            </option>
          ))}
        </select>
      </label>
      <label className="block text-[0.65rem] text-muted">
        Go to a place
        <select
          className="mt-1 block w-full border-2 border-line bg-background px-1.5 py-1 text-xs text-foreground"
          value=""
          onChange={(event) => event.target.value && onPick({ type: "building", id: event.target.value })}
        >
          <option value="">Choose…</option>
          {snapshot.buildings.map((building) => (
            <option key={building.id} value={building.id}>
              {building.name}
            </option>
          ))}
        </select>
      </label>
    </section>
  );
}
