/**
 * Static check for the default-branch payout workflows.
 * GitHub runs `schedule` from `main`. This file fails closed if that schedule
 * can start the ChogBank broadcaster, or if the manual workflow can run
 * before its decision-id check and checkout guard.
 */
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

const mind = readFileSync(".github/workflows/ai-mind.yml", "utf8");
const manual = readFileSync(".github/workflows/chogbank-payout.yml", "utf8");

assert.match(mind, /^ {2}schedule:$/m, "the AI mind schedule must remain");
assert.match(mind, /\/api\/ai\/run/, "the scheduled mind run must remain");
assert.match(mind, /scripts\/issue-wallet-decisions\.ts/, "wallet issuance must remain");
assert.match(mind, /ref: cursor\/phase-1-genesis-world-155c/, "issuance must check out the production branch");
assert.doesNotMatch(mind, /broadcast-chogbank-payouts/, "the schedule must not start the payout broadcaster");
assert.doesNotMatch(mind, /CHOG_BANK_AUTHORIZER_KEY/, "the schedule must not receive the authorizer key");
assert.doesNotMatch(mind, /CHOG_BANK_DECISION_ID/, "the schedule must not carry a payout decision id");
assert.doesNotMatch(mind, /^ {2}pay:$/m, "the schedule must not keep a pay job");

assert.match(manual, /workflow_dispatch:/);
assert.match(manual, /decision_id:/);
assert.match(manual, /CHOG_BANK_DECISION_ID/);
assert.match(manual, /CHOG_BANK_AUTHORIZER_KEY/);
assert.match(manual, /ref: cursor\/phase-1-genesis-world-155c/);
assert.match(manual, /grep -q "CHOG_BANK_DECISION_ID"/);
assert.match(manual, /grep -q "selectManualPayout"/);
assert.doesNotMatch(manual, /schedule:/, "the manual payout workflow must not be scheduled");
assert.doesNotMatch(manual, /\/api\/ai\/run/, "the manual payout workflow must not call the mind");
assert.doesNotMatch(manual, /WALLET_ISSUER_AGENT_KEY/, "the manual payout workflow must not receive the wallet agent key");

const idRefusal = manual.indexOf("Nothing was signed.");
const guard = manual.indexOf('grep -q "selectManualPayout"');
const broadcast = manual.indexOf("npx tsx scripts/broadcast-chogbank-payouts.ts");
assert.ok(idRefusal > 0 && guard > idRefusal && broadcast > guard, "validation must exit before the broadcaster starts");

const decisionStep = manual.slice(manual.indexOf("Check the decision id"), manual.indexOf("Check payout secrets"));
assert.match(decisionStep, /exit 1/, "a malformed decision id must exit before secrets are used to sign");

console.log("payout workflow checks passed");
