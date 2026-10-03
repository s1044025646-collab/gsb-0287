import { DatabaseSync } from "node:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import { RobinHoodTable, OpTrace, SlotEntry, MIN_CAPACITY } from "./table";

export const DATA_DIR = path.join(process.cwd(), "data");
const DB_PATH = path.join(DATA_DIR, "robinhood.db");

export interface TableMeta {
  id: number;
  name: string;
  capacity: number;
  maxCapacity: number;
  size: number;
  createdAt: string;
}

export interface OpRecord {
  seq: number;
  op: string;
  key: string | null;
  trace: OpTrace;
}

export class Store {
  private db: DatabaseSync;

  constructor(dbPath: string = DB_PATH) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS experiments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        initial_capacity INTEGER NOT NULL,
        max_capacity INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS ops (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        table_id INTEGER NOT NULL REFERENCES experiments(id),
        seq INTEGER NOT NULL,
        op TEXT NOT NULL,
        key TEXT,
        value TEXT,
        trace TEXT NOT NULL,
        UNIQUE(table_id, seq)
      );
      CREATE TABLE IF NOT EXISTS snapshots (
        table_id INTEGER PRIMARY KEY REFERENCES experiments(id),
        capacity INTEGER NOT NULL,
        size INTEGER NOT NULL,
        slots TEXT NOT NULL
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  createTable(name: string, initialCapacity = MIN_CAPACITY, maxCapacity = 1 << 20): TableMeta {
    new RobinHoodTable(initialCapacity, maxCapacity);
    const stmt = this.db.prepare(
      "INSERT INTO experiments (name, initial_capacity, max_capacity, created_at) VALUES (?, ?, ?, ?)"
    );
    const res = stmt.run(name, initialCapacity, maxCapacity, new Date().toISOString());
    const id = Number(res.lastInsertRowid);
    this.saveSnapshot(id, new RobinHoodTable(initialCapacity, maxCapacity));
    return this.getMeta(id)!;
  }

  listTables(): TableMeta[] {
    const rows = this.db
      .prepare(
        `SELECT e.id, e.name, e.created_at, s.capacity, s.size, e.max_capacity
         FROM experiments e JOIN snapshots s ON s.table_id = e.id ORDER BY e.id`
      )
      .all() as any[];
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      capacity: r.capacity,
      maxCapacity: r.max_capacity,
      size: r.size,
      createdAt: r.created_at,
    }));
  }

  getMeta(id: number): TableMeta | null {
    return this.listTables().find((t) => t.id === id) ?? null;
  }

  loadTable(id: number): RobinHoodTable | null {
    const meta = this.getMeta(id);
    if (!meta) return null;
    const row = this.db.prepare("SELECT capacity, slots FROM snapshots WHERE table_id = ?").get(id) as any;
    const slots = JSON.parse(row.slots) as (SlotEntry | null)[];
    return RobinHoodTable.restore(row.capacity, meta.maxCapacity, slots);
  }

  private saveSnapshot(id: number, table: RobinHoodTable): void {
    this.db
      .prepare(
        `INSERT INTO snapshots (table_id, capacity, size, slots) VALUES (?, ?, ?, ?)
         ON CONFLICT(table_id) DO UPDATE SET capacity=excluded.capacity, size=excluded.size, slots=excluded.slots`
      )
      .run(id, table.capacity, table.size, JSON.stringify(table.dumpSlots()));
  }

  recordOp(id: number, op: string, key: string | null, value: unknown, trace: OpTrace, table: RobinHoodTable): number {
    const row = this.db.prepare("SELECT COALESCE(MAX(seq), 0) AS m FROM ops WHERE table_id = ?").get(id) as any;
    const seq = row.m + 1;
    this.db
      .prepare("INSERT INTO ops (table_id, seq, op, key, value, trace) VALUES (?, ?, ?, ?, ?, ?)")
      .run(id, seq, op, key, value === undefined ? null : JSON.stringify(value), JSON.stringify(trace));
    this.saveSnapshot(id, table);
    return seq;
  }

  listOps(id: number): OpRecord[] {
    const rows = this.db
      .prepare("SELECT seq, op, key, trace FROM ops WHERE table_id = ? ORDER BY seq")
      .all(id) as any[];
    return rows.map((r) => ({ seq: r.seq, op: r.op, key: r.key, trace: JSON.parse(r.trace) }));
  }

  replay(id: number, toSeq?: number): { seq: number; op: OpRecord | null; slots: (SlotEntry | null)[] }[] {
    const initRow = this.db
      .prepare("SELECT initial_capacity, max_capacity FROM experiments WHERE id = ?")
      .get(id) as any;
    if (!initRow) throw new Error("TABLE_NOT_FOUND");
    const ops = this.listOps(id);
    const limit = toSeq === undefined ? ops.length : Math.min(toSeq, ops.length);
    const table = new RobinHoodTable(initRow.initial_capacity, initRow.max_capacity);
    const steps: { seq: number; op: OpRecord | null; slots: (SlotEntry | null)[] }[] = [
      { seq: 0, op: null, slots: table.dumpSlots() },
    ];
    const valueRows = this.db
      .prepare("SELECT seq, value FROM ops WHERE table_id = ? ORDER BY seq")
      .all(id) as any[];
    for (let i = 0; i < limit; i++) {
      const rec = ops[i];
      const value = valueRows[i].value !== null ? JSON.parse(valueRows[i].value) : undefined;
      if (rec.op === "set") table.set(rec.key!, value);
      else if (rec.op === "delete") table.delete(rec.key!);
      steps.push({ seq: rec.seq, op: rec, slots: table.dumpSlots() });
    }
    return steps;
  }

  exportSnapshot(id: number): object | null {
    const meta = this.getMeta(id);
    if (!meta) return null;
    const table = this.loadTable(id)!;
    return { meta, slots: table.dumpSlots(), ops: this.listOps(id) };
  }
}
