import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { MarketSnapshot } from "../modules/market-data/types.js";
import type { MarketHealth } from "../modules/data-reliability/engine.js";

export interface TxRow {
  trade_id: string;
  proposal_id: string;
  asset: string;
  side: string;
  tier: string;
  hash: string | null;
  nonce: number | null;
  status: string;
  deadline: number;
  submitted_at: number;
  updated_at: number;
  attempts: number;
  payload: string;
}

export interface TradeRow {
  trade_id: string;
  at: number;
  asset: string;
  side: string;
  tier: string;
  amount_in: string;
  amount_out: string;
  realized_pnl: string;
  expected_net: string;
  gas_used: string;
  gas_price: string;
  tx_hash: string;
  block: number;
  prediction_hash: string | null;
}

export interface PredictionRow {
  hash: string;
  trade_id: string | null;
  asset: string;
  direction: string;
  entry: number;
  target: number;
  invalidation: number;
  probability: number;
  expires_at: number;
  created_at: number;
  payload: string;
  outcome: string | null;
  resolved_at: number | null;
  resolved_price: number | null;
}

/**
 * Append-only local store (Node's built-in SQLite — no native build step).
 * Raw snapshots and their reliability verdicts are kept separately (design principle:
 * separate raw market data from derived analytics).
 */
export class Store {
  readonly db: DatabaseSync;

  constructor(path = process.env.COUNTERSIGN_DB ?? "./data/countersign.db") {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS market_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        taken_at INTEGER NOT NULL,
        chain_id INTEGER NOT NULL,
        block_number INTEGER,
        payload TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS market_health (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        snapshot_id INTEGER NOT NULL REFERENCES market_snapshots(id),
        evaluated_at INTEGER NOT NULL,
        status TEXT NOT NULL,
        payload TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_snap_time ON market_snapshots(taken_at);
      CREATE INDEX IF NOT EXISTS idx_health_time ON market_health(evaluated_at);
      CREATE TRIGGER IF NOT EXISTS snapshots_append_only BEFORE UPDATE ON market_snapshots
        BEGIN SELECT RAISE(ABORT, 'market_snapshots is append-only'); END;
      CREATE TRIGGER IF NOT EXISTS health_append_only BEFORE UPDATE ON market_health
        BEGIN SELECT RAISE(ABORT, 'market_health is append-only'); END;
      -- Decision journal: every APPROVE / WAIT / REJECT / SKIP gets a gap-free sequence number.
      -- Ranges of seq are later Merkle-anchored on-chain via vault.anchorDecisions().
      CREATE TABLE IF NOT EXISTS decisions (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        at INTEGER NOT NULL,
        kind TEXT NOT NULL,
        asset TEXT,
        outcome TEXT NOT NULL,
        summary TEXT NOT NULL,
        payload TEXT NOT NULL,
        hash TEXT NOT NULL
      );
      CREATE TRIGGER IF NOT EXISTS decisions_append_only BEFORE UPDATE ON decisions
        BEGIN SELECT RAISE(ABORT, 'decisions is append-only'); END;
      CREATE TRIGGER IF NOT EXISTS decisions_no_delete BEFORE DELETE ON decisions
        BEGIN SELECT RAISE(ABORT, 'decisions is append-only'); END;

      -- Transaction lifecycle (operational state; every change is also appended to tx_events)
      CREATE TABLE IF NOT EXISTS transactions (
        trade_id TEXT PRIMARY KEY,           -- one row per tradeId: the vault executes each at most once
        proposal_id TEXT NOT NULL,
        asset TEXT NOT NULL,
        side TEXT NOT NULL,
        tier TEXT NOT NULL,
        hash TEXT,
        nonce INTEGER,
        status TEXT NOT NULL,                -- SUBMITTED|PENDING|CONFIRMED|REVERTED|REPLACED|DROPPED|CANCELLED|FAILED
        deadline INTEGER NOT NULL,
        submitted_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 1,
        payload TEXT NOT NULL                -- path, permit, signature, prediction, guardian decision hash
      );
      CREATE TABLE IF NOT EXISTS tx_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        trade_id TEXT NOT NULL,
        at INTEGER NOT NULL,
        event TEXT NOT NULL,
        detail TEXT NOT NULL
      );
      CREATE TRIGGER IF NOT EXISTS tx_events_append_only BEFORE UPDATE ON tx_events
        BEGIN SELECT RAISE(ABORT, 'tx_events is append-only'); END;

      -- Confirmed fills (from the vault's TradeExecuted event)
      CREATE TABLE IF NOT EXISTS trades (
        trade_id TEXT PRIMARY KEY,
        at INTEGER NOT NULL,
        asset TEXT NOT NULL,
        side TEXT NOT NULL,
        tier TEXT NOT NULL,
        amount_in TEXT NOT NULL,
        amount_out TEXT NOT NULL,
        realized_pnl TEXT NOT NULL,          -- quote raw, from the vault event
        expected_net TEXT NOT NULL,          -- Guardian's committed expectation, quote raw
        gas_used TEXT NOT NULL,
        gas_price TEXT NOT NULL,
        tx_hash TEXT NOT NULL,
        block INTEGER NOT NULL,
        prediction_hash TEXT
      );
      CREATE TRIGGER IF NOT EXISTS trades_append_only BEFORE UPDATE ON trades
        BEGIN SELECT RAISE(ABORT, 'trades is append-only'); END;

      -- Merkle anchors of decision ranges committed on-chain (vault.anchorDecisions)
      CREATE TABLE IF NOT EXISTS anchors (
        idx INTEGER PRIMARY KEY,             -- the vault's anchor index
        local_from INTEGER NOT NULL,
        local_to INTEGER NOT NULL,
        onchain_from INTEGER NOT NULL,
        root TEXT NOT NULL,
        tx TEXT NOT NULL,
        at INTEGER NOT NULL
      );
      CREATE TRIGGER IF NOT EXISTS anchors_append_only BEFORE UPDATE ON anchors
        BEGIN SELECT RAISE(ABORT, 'anchors is append-only'); END;

      -- Sworn predictions and their graded outcomes
      CREATE TABLE IF NOT EXISTS predictions (
        hash TEXT PRIMARY KEY,
        trade_id TEXT,
        asset TEXT NOT NULL,
        direction TEXT NOT NULL,
        entry REAL NOT NULL,
        target REAL NOT NULL,
        invalidation REAL NOT NULL,
        probability REAL NOT NULL,
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        payload TEXT NOT NULL,
        outcome TEXT,                        -- HIT | INVALIDATED | EXPIRED (null while open)
        resolved_at INTEGER,
        resolved_price REAL
      );
    `);
  }

  // ------------------------------------------------------------------ transactions
  txUpsert(t: { tradeId: string; proposalId: string; asset: string; side: string; tier: string; hash: string | null; nonce: number | null; status: string; deadline: number; payload: unknown; at?: number }) {
    const now = t.at ?? Date.now();
    const p = JSON.stringify(t.payload, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
    this.db
      .prepare(
        `INSERT INTO transactions (trade_id, proposal_id, asset, side, tier, hash, nonce, status, deadline, submitted_at, updated_at, payload)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(trade_id) DO UPDATE SET hash = excluded.hash, nonce = excluded.nonce, status = excluded.status,
           deadline = excluded.deadline, updated_at = excluded.updated_at, attempts = attempts + 1, payload = excluded.payload`,
      )
      .run(t.tradeId, t.proposalId, t.asset, t.side, t.tier, t.hash, t.nonce, t.status, t.deadline, now, now, p);
    this.txEvent(t.tradeId, `SUBMIT ${t.status}`, { hash: t.hash, nonce: t.nonce });
  }

  txSetStatus(tradeId: string, status: string, detail: unknown = {}) {
    this.db.prepare("UPDATE transactions SET status = ?, updated_at = ? WHERE trade_id = ?").run(status, Date.now(), tradeId);
    this.txEvent(tradeId, status, detail);
  }

  txEvent(tradeId: string, event: string, detail: unknown) {
    this.db.prepare("INSERT INTO tx_events (trade_id, at, event, detail) VALUES (?, ?, ?, ?)").run(tradeId, Date.now(), event, JSON.stringify(detail ?? {}, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
  }

  txGet(tradeId: string): TxRow | null {
    return (this.db.prepare("SELECT * FROM transactions WHERE trade_id = ?").get(tradeId) as TxRow | undefined) ?? null;
  }

  txActive(): TxRow[] {
    return this.db.prepare("SELECT * FROM transactions WHERE status IN ('SUBMITTED','PENDING') ORDER BY nonce").all() as unknown as TxRow[];
  }

  txRecent(limit = 50): TxRow[] {
    return this.db.prepare("SELECT * FROM transactions ORDER BY updated_at DESC LIMIT ?").all(limit) as unknown as TxRow[];
  }

  txEvents(tradeId: string): { at: number; event: string; detail: string }[] {
    return this.db.prepare("SELECT at, event, detail FROM tx_events WHERE trade_id = ? ORDER BY id").all(tradeId) as never;
  }

  // ------------------------------------------------------------------ trades & predictions
  recordTrade(t: { tradeId: string; at: number; asset: string; side: string; tier: string; amountIn: string; amountOut: string; realizedPnl: string; expectedNet: string; gasUsed: string; gasPrice: string; txHash: string; block: number; predictionHash: string | null }) {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO trades (trade_id, at, asset, side, tier, amount_in, amount_out, realized_pnl, expected_net, gas_used, gas_price, tx_hash, block, prediction_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(t.tradeId, t.at, t.asset, t.side, t.tier, t.amountIn, t.amountOut, t.realizedPnl, t.expectedNet, t.gasUsed, t.gasPrice, t.txHash, t.block, t.predictionHash);
  }

  trades(): TradeRow[] {
    return this.db.prepare("SELECT * FROM trades ORDER BY at").all() as unknown as TradeRow[];
  }

  recordPrediction(p: { hash: string; tradeId: string | null; asset: string; direction: string; entry: number; target: number; invalidation: number; probability: number; expiresAt: number; createdAt: number; payload: unknown }) {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO predictions (hash, trade_id, asset, direction, entry, target, invalidation, probability, expires_at, created_at, payload)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(p.hash, p.tradeId, p.asset, p.direction, p.entry, p.target, p.invalidation, p.probability, p.expiresAt, p.createdAt, JSON.stringify(p.payload));
  }

  openPredictions(): PredictionRow[] {
    return this.db.prepare("SELECT * FROM predictions WHERE outcome IS NULL").all() as unknown as PredictionRow[];
  }

  resolvePrediction(hash: string, outcome: string, price: number) {
    // write-once: a resolved prediction can never be re-graded
    this.db.prepare("UPDATE predictions SET outcome = ?, resolved_at = ?, resolved_price = ? WHERE hash = ? AND outcome IS NULL").run(outcome, Date.now(), price, hash);
  }

  predictions(): PredictionRow[] {
    return this.db.prepare("SELECT * FROM predictions ORDER BY created_at").all() as unknown as PredictionRow[];
  }

  recordDecision(d: { at: number; kind: string; asset: string | null; outcome: string; summary: string; payload: unknown; hash: string }): number {
    const r = this.db
      .prepare("INSERT INTO decisions (at, kind, asset, outcome, summary, payload, hash) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(d.at, d.kind, d.asset, d.outcome, d.summary, JSON.stringify(d.payload, (_k, v) => (typeof v === "bigint" ? v.toString() : v)), d.hash);
    return Number(r.lastInsertRowid);
  }

  decisionHashesFrom(fromSeq: number): { seq: number; hash: string }[] {
    return this.db.prepare("SELECT seq, hash FROM decisions WHERE seq >= ? ORDER BY seq").all(fromSeq) as never;
  }

  decisionRow(seq: number): { seq: number; at: number; kind: string; summary: string; payload: string; hash: string } | null {
    return (this.db.prepare("SELECT seq, at, kind, summary, payload, hash FROM decisions WHERE seq = ?").get(seq) as never) ?? null;
  }

  lastAnchor(): { idx: number; local_from: number; local_to: number; onchain_from: number; root: string; tx: string } | null {
    return (this.db.prepare("SELECT * FROM anchors ORDER BY idx DESC LIMIT 1").get() as never) ?? null;
  }

  anchorFor(seq: number): { idx: number; local_from: number; local_to: number; onchain_from: number; root: string; tx: string } | null {
    return (this.db.prepare("SELECT * FROM anchors WHERE local_from <= ? AND local_to >= ?").get(seq, seq) as never) ?? null;
  }

  recordAnchor(a: { idx: number; localFrom: number; localTo: number; onchainFrom: number; root: string; tx: string }) {
    this.db.prepare("INSERT INTO anchors (idx, local_from, local_to, onchain_from, root, tx, at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(a.idx, a.localFrom, a.localTo, a.onchainFrom, a.root, a.tx, Date.now());
  }

  recentDecisions(limit = 50): { seq: number; at: number; kind: string; asset: string | null; outcome: string; summary: string; hash: string }[] {
    return this.db
      .prepare("SELECT seq, at, kind, asset, outcome, summary, hash FROM decisions ORDER BY seq DESC LIMIT ?")
      .all(limit) as never;
  }

  decision(seq: number): { seq: number; payload: unknown; hash: string } | null {
    const r = this.db.prepare("SELECT seq, payload, hash FROM decisions WHERE seq = ?").get(seq) as { seq: number; payload: string; hash: string } | undefined;
    return r ? { seq: r.seq, payload: JSON.parse(r.payload), hash: r.hash } : null;
  }

  /** DEX spot series for one asset, oldest first (Tier C z-score input). */
  dexSeries(asset: string, limit = 120): number[] {
    return this.history(asset, limit).map((p) => p.dex);
  }

  record(snap: MarketSnapshot, health: MarketHealth): number {
    const r = this.db
      .prepare("INSERT INTO market_snapshots (taken_at, chain_id, block_number, payload) VALUES (?, ?, ?, ?)")
      .run(snap.takenAt, snap.chainId, snap.head?.blockNumber ?? null, JSON.stringify(snap));
    const id = Number(r.lastInsertRowid);
    this.db
      .prepare("INSERT INTO market_health (snapshot_id, evaluated_at, status, payload) VALUES (?, ?, ?, ?)")
      .run(id, health.evaluatedAt, health.status, JSON.stringify(health));
    return id;
  }

  latest(): { snapshot: MarketSnapshot; health: MarketHealth; id: number } | null {
    const row = this.db
      .prepare(
        "SELECT s.id, s.payload AS snap, h.payload AS health FROM market_snapshots s JOIN market_health h ON h.snapshot_id = s.id ORDER BY s.id DESC LIMIT 1",
      )
      .get() as { id: number; snap: string; health: string } | undefined;
    return row ? { id: row.id, snapshot: JSON.parse(row.snap), health: JSON.parse(row.health) } : null;
  }

  /** Recent DEX spot / reference history for one asset (for charts and the strategist). */
  history(asset: string, limit = 360): { t: number; dex: number; ref: number | null; status: string }[] {
    const rows = this.db
      .prepare("SELECT evaluated_at AS t, payload FROM market_health ORDER BY id DESC LIMIT ?")
      .all(limit) as { t: number; payload: string }[];
    return rows
      .map((r) => {
        const h = JSON.parse(r.payload) as MarketHealth;
        const a = h.assets.find((x) => x.asset === asset);
        return a ? { t: r.t, dex: a.dexSpot, ref: a.reference, status: a.status } : null;
      })
      .filter((x): x is NonNullable<typeof x> => x !== null)
      .reverse();
  }

  count(): number {
    return Number((this.db.prepare("SELECT COUNT(*) AS n FROM market_snapshots").get() as { n: number }).n);
  }
}
