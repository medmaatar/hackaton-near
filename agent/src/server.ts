/** HTTP surface: live event stream for the dashboard plus a demo trigger. */

import { createServer } from "node:http";
import { audit } from "./audit.js";
import { config, hasAgentKey, llmEnabled } from "./config.js";
import { runtime } from "./runtime.js";
import { runDemo, snapshot } from "./broker.js";
import * as near from "./contract.js";
import { DESKS } from "./desks.js";

const PORT = config.port;

function jsonStringify(obj: unknown): string {
  return JSON.stringify(obj, (_, v) => (typeof v === "bigint" ? v.toString() : v));
}

function json(res: import("node:http").ServerResponse, status: number, body: unknown) {
  const payload = jsonStringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(payload);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    return res.end();
  }

  if (url.pathname === "/health") {
    return json(res, 200, {
      ok: true,
      settlementMode: config.settlementMode,
      contract: runtime.contractId,
      chain: runtime.chain,
      agent: config.agentAccount,
      hasAgentKey,
      llm: llmEnabled,
    });
  }

  if (url.pathname === "/api/desks") {
    return json(res, 200, DESKS);
  }

  if (url.pathname === "/api/state") {
    const snap = snapshot();
    let reputation: Record<string, unknown> = {};
    try {
      const entries = await Promise.all(
        DESKS.map(async (d) => [d.account, await near.getReputation(d.account)] as const),
      );
      reputation = Object.fromEntries(entries);
    } catch {
      /* chain unreachable: the dashboard still shows the local run */
    }
    return json(res, 200, { ...snap, reputation, events: audit.history() });
  }

  if (url.pathname === "/events") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*",
    });
    res.write(`retry: 2000\n\n`);
    for (const e of audit.history()) res.write(`data: ${jsonStringify(e)}\n\n`);
    const unsubscribe = audit.subscribe((e) => res.write(`data: ${jsonStringify(e)}\n\n`));
    const keepAlive = setInterval(() => res.write(`: ping\n\n`), 15_000);
    req.on("close", () => {
      clearInterval(keepAlive);
      unsubscribe();
    });
    return;
  }

  if (url.pathname === "/api/demo/run" && req.method === "POST") {
    const body = await readBody(req);
    const mandateId = Number(body.mandateId ?? runtime.mandateId);
    runDemo(mandateId).catch((err) => audit.log("error", "agent", String(err)));
    return json(res, 202, { started: true, mandateId });
  }

  json(res, 404, { error: "not found" });
});

async function readBody(req: import("node:http").IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return {};
  }
}

server.listen(PORT, () => {
  console.log(`mandate-otc agent listening on :${PORT} (${config.settlementMode} mode)`);
  console.log(`contract ${config.contractId} on ${config.network}`);
});
