/** Append-only audit trail. Every step the broker takes lands here. */

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { AuditEvent, AuditKind } from "./types.js";

export const AUDIT_PATH = process.env.AUDIT_PATH ?? "/data/audit.jsonl";
const MAX_BUFFER = 2000;

type Listener = (e: AuditEvent) => void;

class Audit {
  private seq = 0;
  private buffer: AuditEvent[] = [];
  private listeners = new Set<Listener>();

  constructor() {
    try {
      mkdirSync(dirname(AUDIT_PATH), { recursive: true });
    } catch {
      /* read-only filesystem: keep the in-memory trail */
    }
  }

  log(
    kind: AuditKind,
    actor: AuditEvent["actor"],
    message: string,
    data?: Record<string, unknown>,
  ): AuditEvent {
    const event: AuditEvent = {
      seq: ++this.seq,
      ts: Date.now(),
      kind,
      actor,
      message,
      data,
    };
    this.buffer.push(event);
    if (this.buffer.length > MAX_BUFFER) this.buffer.shift();
    try {
      const line = JSON.stringify(event, (_, v) => (typeof v === "bigint" ? v.toString() : v));
      appendFileSync(AUDIT_PATH, line + "\n");
    } catch {
      /* disk full or read-only: the SSE stream still has it */
    }
    for (const l of this.listeners) l(event);
    return event;
  }

  history(): AuditEvent[] {
    return this.buffer;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}

export const audit = new Audit();
