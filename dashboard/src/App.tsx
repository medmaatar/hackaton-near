import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type EventKind = string;

interface AuditEvent {
  seq: number;
  ts: number;
  kind: EventKind;
  actor: string;
  message: string;
  data?: Record<string, unknown>;
}

interface Leg {
  id: number;
  desk: string;
  deskName: string;
  account: string;
  size: string;
  sizeFormatted: string;
  edgeBps: number;
  status: "pending" | "checking" | "rejected" | "executed" | "settled" | "failed";
  rejectCode?: string;
  rejectReason?: string;
  depositAddress?: string;
  amountOutFormatted?: string;
}

interface Mandate {
  id: number;
  owner: string;
  agent: string;
  pair: string;
  max_size: string;
  spent: string;
  max_slippage_bps: number;
  min_reputation: number;
  expiry: number;
  fee_bps: number;
  status: string;
  trades: number;
  allowed_counterparties: string[];
}

interface Snapshot {
  running: boolean;
  stage: string;
  mandateId: number;
  mandate?: Mandate;
  legs: Leg[];
  events: AuditEvent[];
  reputation: Record<string, { score: number; completed: number; failed: number }>;
  error?: string;
}

const usdc = (v?: string | number) =>
  v === undefined ? "—" : (Number(v) / 1e6).toLocaleString("en-US", { maximumFractionDigits: 2 });

const short = (a?: string) => (a && a.length > 20 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a ?? "—");

const time = (ts: number) => new Date(ts).toLocaleTimeString("en-GB", { hour12: false });

const kindTone = (kind: string): string => {
  if (kind === "contract.rejected" || kind === "risk.veto" || kind === "error") return "bad";
  if (kind === "contract.approved" || kind === "settlement.settled" || kind === "reputation.updated")
    return "good";
  if (kind === "contract.check" || kind === "risk.approved") return "check";
  if (kind.startsWith("desk.")) return "desk";
  return "neutral";
};

export default function App() {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const [starting, setStarting] = useState(false);
  const seen = useRef(new Set<number>());

  const absorb = useCallback((incoming: AuditEvent[]) => {
    const fresh = incoming.filter((e) => !seen.current.has(e.seq));
    if (fresh.length === 0) return;
    fresh.forEach((e) => seen.current.add(e.seq));
    setEvents((prev) => [...prev, ...fresh].sort((a, b) => a.seq - b.seq).slice(-400));
  }, []);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/state");
      if (!res.ok) return;
      const data = (await res.json()) as Snapshot;
      setSnap(data);
      absorb(data.events ?? []);
    } catch {
      /* agent not up yet */
    }
  }, [absorb]);

  useEffect(() => {
    refresh();
    const stream = new EventSource("/events");
    stream.onopen = () => setConnected(true);
    stream.onerror = () => setConnected(false);
    stream.onmessage = (msg) => {
      try {
        absorb([JSON.parse(msg.data) as AuditEvent]);
      } catch {
        /* ignore malformed frames */
      }
    };
    const poll = setInterval(refresh, 4000);
    return () => {
      stream.close();
      clearInterval(poll);
    };
  }, [absorb, refresh]);

  const run = async () => {
    setStarting(true);
    try {
      await fetch("/api/demo/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mandateId: snap?.mandateId ?? 0 }),
      });
      setTimeout(refresh, 600);
    } finally {
      setTimeout(() => setStarting(false), 1200);
    }
  };

  const blocked = useMemo(
    () => events.filter((e) => e.kind === "contract.rejected").at(-1),
    [events],
  );

  const m = snap?.mandate;
  const legs = snap?.legs ?? [];
  const spent = m ? Number(m.spent) : 0;
  const cap = m ? Number(m.max_size) : 0;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="mark">◈</span>
          <div>
            <h1>Mandate OTC</h1>
            <p>AI broker, human limits, onchain veto</p>
          </div>
        </div>
        <div className="topmeta">
          <span className={`pill ${connected ? "live" : "dead"}`}>
            {connected ? "live" : "reconnecting"}
          </span>
          <span className="pill ghost">{snap?.stage ?? "idle"}</span>
          <a className="pill ghost mono" href="#contract" onClick={(e) => e.preventDefault()}>
            {m ? `mandate #${m.id}` : `mandate #${snap?.mandateId ?? 0}`}
          </a>
          <button className="run" onClick={run} disabled={starting || snap?.running}>
            {snap?.running ? "negotiating…" : starting ? "starting…" : "Run negotiation"}
          </button>
        </div>
      </header>

      {blocked && (
        <div className="blocked">
          <div className="blockedTitle">
            <span>Blocked onchain</span>
            <code>{String(blocked.data?.code ?? "")}</code>
          </div>
          <p>{blocked.message}</p>
          <small>
            The agent proposed it anyway. The contract refused, so no funds moved.
          </small>
        </div>
      )}

      <main className="grid">
        <section className="panel transcript">
          <div className="panelHead">
            <h2>Negotiation</h2>
            <span className="hint">every step, appended as it happens</span>
          </div>
          <ol className="feed">
            {events.length === 0 && <li className="empty">no events yet — run a negotiation</li>}
            {events.map((e) => (
              <li key={e.seq} className={`row ${kindTone(e.kind)}`}>
                <span className="t mono">{time(e.ts)}</span>
                <span className={`who ${e.actor}`}>{e.actor}</span>
                <span className="msg">{e.message}</span>
              </li>
            ))}
          </ol>
        </section>

        <aside className="rail">
          <section className="panel">
            <div className="panelHead">
              <h2>Mandate</h2>
              {m && <span className={`status ${m.status.toLowerCase()}`}>{m.status}</span>}
            </div>
            {m ? (
              <>
                <dl className="kv">
                  <dt>pair</dt>
                  <dd className="mono">{m.pair}</dd>
                  <dt>owner</dt>
                  <dd className="mono">{short(m.owner)}</dd>
                  <dt>agent</dt>
                  <dd className="mono">{short(m.agent)}</dd>
                  <dt>price floor</dt>
                  <dd className="mono">−{m.max_slippage_bps} bps</dd>
                  <dt>performance fee</dt>
                  <dd className="mono">{(m.fee_bps / 100).toFixed(2)}%</dd>
                  <dt>min reputation</dt>
                  <dd className="mono">{m.min_reputation}</dd>
                  <dt>expires</dt>
                  <dd className="mono">
                    {new Date(m.expiry / 1_000_000).toLocaleTimeString("en-GB", { hour12: false })}
                  </dd>
                </dl>
                <div className="cap">
                  <div className="capBar">
                    <span style={{ width: `${cap ? Math.min(100, (spent / cap) * 100) : 0}%` }} />
                  </div>
                  <div className="capLabel mono">
                    {usdc(spent)} / {usdc(cap)} USDC spent
                  </div>
                </div>
              </>
            ) : (
              <p className="empty">loading mandate…</p>
            )}
          </section>

          <section className="panel">
            <div className="panelHead">
              <h2>Trades</h2>
              <span className="hint">{legs.length} legs</span>
            </div>
            {legs.length === 0 ? (
              <p className="empty">nothing proposed yet</p>
            ) : (
              <ul className="legs">
                {legs.map((l) => (
                  <li key={`${l.id}-${l.desk}`} className={l.status}>
                    <div className="legTop">
                      <strong>{l.deskName}</strong>
                      <span className="mono">{l.sizeFormatted} USDC</span>
                    </div>
                    <div className="legBottom">
                      <span className={`badge ${l.status}`}>{l.status}</span>
                      {l.rejectCode ? (
                        <span className="reason mono">{l.rejectCode}</span>
                      ) : (
                        <span className="reason mono">{l.edgeBps} bps</span>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="panel">
            <div className="panelHead">
              <h2>Desk reputation</h2>
              <span className="hint">onchain score</span>
            </div>
            <ul className="rep">
              {Object.entries(snap?.reputation ?? {}).map(([account, r]) => (
                <li key={account}>
                  <span className="mono">{short(account)}</span>
                  <span className="scoreBar">
                    <span style={{ width: `${r.score}%` }} />
                  </span>
                  <span className="mono score">{r.score}</span>
                </li>
              ))}
              {Object.keys(snap?.reputation ?? {}).length === 0 && (
                <li className="empty">no counterparties scored yet</li>
              )}
            </ul>
          </section>
        </aside>
      </main>

      <footer className="foot">
        <span>
          policy engine: <code>check_trade</code> · settlement: NEAR Intents · vault: contract-held USDC
        </span>
        <span className="mono">{snap?.error ? `error: ${snap.error}` : "no key, no custody, no exceptions"}</span>
      </footer>
    </div>
  );
}
