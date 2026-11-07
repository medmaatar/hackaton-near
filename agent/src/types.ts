/** Shared shapes. Money is always bigint base units, never floats. */

export type AssetId = string;

export interface Mandate {
  id: number;
  owner: string;
  agent: string;
  pair: string;
  sell_token: string;
  buy_token: AssetId;
  max_size: string;
  spent: string;
  reference_price: string;
  max_slippage_bps: number;
  allowed_counterparties: string[];
  min_reputation: number;
  expiry: number; // ns
  fee_bps: number;
  status: "Active" | "Paused" | "Closed";
  trades: number;
}

export interface Decision {
  approved: boolean;
  code: string;
  reason: string;
  notional: string;
  price_edge_bps: number;
}

export type DeskBehaviour = "tight" | "block" | "silent" | "bait";

export interface Desk {
  id: string;
  name: string;
  account: string;
  behaviour: DeskBehaviour;
  headline: string;
}

/** A structured offer. No free text ever crosses the negotiation boundary. */
export interface Offer {
  desk: string;
  account: string;
  pair: string;
  size: bigint; // sell-token base units
  minOut: bigint; // buy-token base units
  /** price in bps away from the mandate reference, negative = worse */
  edgeBps: number;
  expiresAt: number; // ms epoch
  note: string;
}

export type AuditKind =
  | "mandate.loaded"
  | "desk.quote"
  | "desk.silent"
  | "desk.counter"
  | "risk.veto"
  | "risk.approved"
  | "contract.check"
  | "contract.rejected"
  | "contract.approved"
  | "settlement.quote"
  | "settlement.submitted"
  | "settlement.settled"
  | "settlement.failed"
  | "reputation.updated"
  | "fee.split"
  | "error";

export interface AuditEvent {
  seq: number;
  ts: number;
  kind: AuditKind;
  actor: "agent" | "desk" | "contract" | "risk" | "settlement" | "user";
  message: string;
  data?: Record<string, unknown>;
}
