/**
 * Terminal demo. Everything the dashboard shows, printed to stdout.
 *
 *   docker compose run --rm agent npm run demo
 *
 * In mock mode the policy checks are real onchain view calls and the settlement
 * leg is simulated, so this runs with no keys and no funds.
 */

import { audit } from "../audit.js";
import { config } from "../config.js";
import { runDemo } from "../broker.js";

audit.subscribe((e) => {
  const time = new Date(e.ts).toISOString().slice(11, 19);
  const actor = e.actor.padEnd(10);
  console.log(`${time} ${actor} ${e.message}`);
});

const mandateId = Number(process.argv[2] ?? process.env.MANDATE_ID ?? 0);
console.log(`\nmandate-otc demo — ${config.settlementMode} mode — mandate #${mandateId}\n`);

const snap = await runDemo(mandateId);

console.log("\n--- result ---");
console.log(`stage: ${snap.stage}`);
for (const leg of snap.legs) {
  const tag = leg.status.toUpperCase().padEnd(9);
  const extra = leg.rejectCode ? ` ${leg.rejectCode}: ${leg.rejectReason ?? ""}` : "";
  console.log(`${tag} ${leg.deskName.padEnd(10)} ${leg.sizeFormatted} USDC${extra}`);
}
if (snap.error) console.log(`error: ${snap.error}`);
console.log("");
