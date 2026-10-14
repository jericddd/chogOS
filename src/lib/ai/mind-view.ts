import type { PersonalityTraits } from "@/lib/ai/personality";

export type CitizenMindView = {
  tokenId: string;
  personality: PersonalityTraits | null;
  personalityOrigin: "deterministic" | null;
  skills: Array<{ name: string; level: number; experience: number }>;
  goals: Array<{
    id: string;
    kind: string;
    title: string;
    summary: string;
    status: string;
    progress: number;
    relatedBuildingId: string | null;
  }>;
  memories: Array<{
    id: string;
    content: string;
    category: string | null;
    outcome: string | null;
    importance: number;
    createdAt: string;
  }>;
  decisions: Array<{
    id: string;
    status: string;
    purpose: string;
    summary: string | null;
    rationale: string | null;
    provider: string | null;
    model: string | null;
    validationResult: string | null;
    intentId: string | null;
    outcomeEventId: string | null;
    createdAt: string;
  }>;
  aiActive: boolean;
};

export type MindLoad =
  | { status: "ok"; mind: CitizenMindView }
  | { status: "missing"; detail: string }
  | { status: "unconfigured" | "migration_pending" | "error"; detail: string };
