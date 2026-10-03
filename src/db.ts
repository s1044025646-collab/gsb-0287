import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import fs from 'node:fs';
import { RobinHoodTable, OpResult, SlotOrNull, MIN_CAPACITY, DEFAULT_MAX_CAPACITY, normalizeCapacity } from './table';

export interface ExperimentRow {
  id: number;
  name: string;
  capacity: number;
  max_capacity: number;
  created_at: string;
}

export class ExperimentError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

export class Store {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS experiments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        capacity INTEGER NOT NULL,
        max_capacity INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS operations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        experiment_id INTEGER NOT NULL,
        seq INTEGER NOT NULL,
        op TEXT NOT NULL,
        key TEXT,
        value TEXT,
        result_json TEXT NOT NULL,
        size_after INTEGER NOT NULL,
        capacity_after INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS snapshots (
        experiment_id INTEGER PRIMARY KEY,
        capacity INTEGER NOT NULL,
        size INTEGER NOT NULL,
        slots_json TEXT NOT NULL
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  createExperiment(name: string, capacity = MIN_CAPACITY, maxCapacity = DEFAULT_MAX_CAPACITY): ExperimentRow {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new ExperimentError('INVALID_PARAM', 'capacity 必须是正整数');
    }
    if (!Number.isInteger(maxCapacity) || maxCapacity < MIN_CAPACITY) {
      throw new ExperimentError('INVALID_PARAM', `maxCapacity 必须是不小于 ${MIN_CAPACITY} 的整数`);
    }
    const cap = normalizeCapacity(capacity);
    const maxCap = normalizeCapacity(maxCapacity);
    if (cap > maxCap) {
      throw new ExperimentError('INVALID_PARAM', 'capacity 不能超过 maxCapacity');
    }
    const stmt = this.db.prepare(
      'INSERT INTO experiments (name, capacity, max_capacity, created_at) VALUES (?, ?, ?, ?)'
    );
    const r = stmt.run(name || 'experiment', cap, maxCap, new Date().toISOString());
    const id = Number(r.lastInsertRowid);
    const t = new RobinHoodTable(cap, maxCap);
    this.saveSnapshot(id, t);
    return this.getExperiment(id)!;
  }

  getExperiment(id: number): ExperimentRow | null {
    const row = this.db.prepare('SELECT * FROM experiments WHERE id = ?').get(id) as ExperimentRow | undefined;
    return row ?? null;
  }

  listExperiments(): ExperimentRow[] {
    return this.db.prepare('SELECT * FROM experiments ORDER BY id').all() as unknown as ExperimentRow[];
  }

  private requireExperiment(id: number): ExperimentRow {
    const row = this.getExperiment(id);
    if (!row) throw new ExperimentError('EXPERIMENT_NOT_FOUND', `实验 ${id} 不存在`);
    return row;
  }

  loadTable(id: number): RobinHoodTable {
    this.requireExperiment(id);
    const snap = this.db.prepare('SELECT * FROM snapshots WHERE experiment_id = ?').get(id) as
      | { capacity: number; size: number; slots_json: string }
      | undefined;
    if (!snap) {
      const exp = this.getExperiment(id)!;
      return new RobinHoodTable(exp.capacity, exp.max_capacity);
    }
    const exp = this.getExperiment(id)!;
    return RobinHoodTable.restore({
      capacity: snap.capacity,
      maxCapacity: exp.max_capacity,
      slots: JSON.parse(snap.slots_json) as SlotOrNull[],
    });
  }

  private saveSnapshot(id: number, t: RobinHoodTable): void {
    const snap = t.snapshot();
    this.db.prepare(
      `INSERT INTO snapshots (experiment_id, capacity, size, slots_json) VALUES (?, ?, ?, ?)
       ON CONFLICT(experiment_id) DO UPDATE SET capacity=excluded.capacity, size=excluded.size, slots_json=excluded.slots_json`
    ).run(id, snap.capacity, snap.size, JSON.stringify(snap.slots));
  }

  private nextSeq(id: number): number {
    const row = this.db.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM operations WHERE experiment_id = ?').get(id) as { m: number };
    return row.m + 1;
  }

  private record(id: number, op: string, key: string | null, value: string | null, result: unknown, t: RobinHoodTable): void {
    this.db.prepare(
      'INSERT INTO operations (experiment_id, seq, op, key, value, result_json, size_after, capacity_after, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(id, this.nextSeq(id), op, key, value, JSON.stringify(result), t.size, t.capacity, new Date().toISOString());
    this.saveSnapshot(id, t);
  }

  put(id: number, key: string, value: unknown): OpResult & { value: string } {
    validateKey(key);
    const json = JSON.stringify(value === undefined ? null : value);
    if (json === undefined) throw new ExperimentError('INVALID_PARAM', 'value 无法序列化为 JSON');
    const t = this.loadTable(id);
    const r = t.put(key, json);
    this.record(id, 'put', key, json, r, t);
    return { ...r, value: json };
  }

  get(id: number, key: string): { found: boolean; value?: unknown; probes: unknown } {
    validateKey(key);
    const t = this.loadTable(id);
    const r = t.get(key);
    this.record(id, 'get', key, null, r, t);
    return { found: r.found, value: r.found ? JSON.parse(r.value!) : undefined, probes: r.probes };
  }

  remove(id: number, key: string): OpResult & { found: boolean } {
    validateKey(key);
    const t = this.loadTable(id);
    const r = t.remove(key);
    this.record(id, 'delete', key, null, r, t);
    return r;
  }

  slots(id: number): { capacity: number; size: number; slots: (unknown | null)[] } {
    const t = this.loadTable(id);
    return {
      capacity: t.capacity,
      size: t.size,
      slots: t.slots.map((s, i) =>
        s === null ? null : { slot: i, key: s.key, hash: s.hash, dist: s.dist, value: JSON.parse(s.value) }
      ),
    };
  }

  operations(id: number): unknown[] {
    this.requireExperiment(id);
    const rows = this.db.prepare(
      'SELECT seq, op, key, value, result_json, size_after, capacity_after, created_at FROM operations WHERE experiment_id = ? ORDER BY seq'
    ).all(id) as unknown as Array<{ result_json: string; value: string | null }>;
    return rows.map((r) => ({
      ...(r as object),
      value: r.value === null ? null : JSON.parse(r.value),
      result: JSON.parse(r.result_json),
      result_json: undefined,
    }));
  }

  exportSnapshot(id: number): unknown {
    const exp = this.requireExperiment(id);
    const t = this.loadTable(id);
    return {
      experiment: exp,
      snapshot: t.snapshot(),
      verify: t.verify(),
    };
  }

  // 历史回放：从初始参数重放前 to 条操作，返回每步之后的槽位状态
  replay(id: number, to?: number): unknown[] {
    const exp = this.requireExperiment(id);
    const rows = this.db.prepare(
      'SELECT seq, op, key, value FROM operations WHERE experiment_id = ? ORDER BY seq'
    ).all(id) as unknown as Array<{ seq: number; op: string; key: string | null; value: string | null }>;
    const limit = to === undefined ? rows.length : Math.min(to, rows.length);
    const t = new RobinHoodTable(exp.capacity, exp.max_capacity);
    const out: unknown[] = [];
    for (const row of rows.slice(0, limit)) {
      let result: unknown;
      if (row.op === 'put') result = t.put(row.key!, row.value!);
      else if (row.op === 'delete') result = t.remove(row.key!);
      else if (row.op === 'get') result = t.get(row.key!);
      out.push({
        seq: row.seq,
        op: row.op,
        key: row.key,
        result,
        state: { size: t.size, capacity: t.capacity, slots: t.snapshot().slots },
      });
    }
    return out;
  }
}

function validateKey(key: unknown): asserts key is string {
  if (typeof key !== 'string' || key.length === 0) {
    throw new ExperimentError('INVALID_PARAM', 'key 必须是非空字符串');
  }
  if (Buffer.byteLength(key, 'utf8') > 1024) {
    throw new ExperimentError('INVALID_PARAM', 'key 过长（UTF-8 超过 1024 字节）');
  }
}
