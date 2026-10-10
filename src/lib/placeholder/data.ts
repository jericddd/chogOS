export const PLACEHOLDER_ORIGIN = "placeholder" as const;

export const placeholderNotice =
  "Sample interface data. It is not loaded from Supabase, and it is not a Monad balance, citizen, or transaction.";

export type SampleCitizen = {
  origin: typeof PLACEHOLDER_ORIGIN;
  id: string;
  label: string;
  token: string;
  lifeStatus: string;
  job: string;
  skills: string;
  wallet: string;
  wealth: string;
};

export const sampleCitizens: SampleCitizen[] = [
  {
    origin: PLACEHOLDER_ORIGIN,
    id: "sample-archivist",
    label: "Sample archivist",
    token: "Sample token",
    lifeStatus: "Preview",
    job: "No job on record",
    skills: "Record keeping",
    wallet: "Not deployed",
    wealth: "Not a balance",
  },
  {
    origin: PLACEHOLDER_ORIGIN,
    id: "sample-builder",
    label: "Sample builder",
    token: "Sample token",
    lifeStatus: "Preview",
    job: "No job on record",
    skills: "Contract design",
    wallet: "Not deployed",
    wealth: "Not a balance",
  },
  {
    origin: PLACEHOLDER_ORIGIN,
    id: "sample-trader",
    label: "Sample trader",
    token: "Sample token",
    lifeStatus: "Preview",
    job: "No job on record",
    skills: "Market notes",
    wallet: "Not deployed",
    wealth: "Not a balance",
  },
];

export type SampleBusiness = {
  origin: typeof PLACEHOLDER_ORIGIN;
  name: string;
  status: string;
  founder: string;
  ledger: string;
  receipt: string;
};

export const sampleBusiness: SampleBusiness = {
  origin: PLACEHOLDER_ORIGIN,
  name: "Sample workshop",
  status: "Not recorded",
  founder: "Sample citizen",
  ledger: "No amount entered",
  receipt: "No Monad transaction",
};

export type SampleEvent = {
  origin: typeof PLACEHOLDER_ORIGIN;
  when: string;
  summary: string;
  receipt: string;
};

export const sampleEvents: SampleEvent[] = [
  {
    origin: PLACEHOLDER_ORIGIN,
    when: "Not a date on chain",
    summary: "Sample: the civilization shell was opened.",
    receipt: "No transaction",
  },
  {
    origin: PLACEHOLDER_ORIGIN,
    when: "Not a date on chain",
    summary: "Sample: a citizen proposed a workshop.",
    receipt: "No transaction",
  },
];
