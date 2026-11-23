import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { MarketSnapshot } from "../modules/market-data/types.js";
import type { MarketHealth } from "../modules/data-reliability/engine.js";

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
    `);
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
