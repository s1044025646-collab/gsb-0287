import { fnv1a32, bucketOf } from './fnv';

export interface Slot {
  key: string;
  hash: number;   // 完整 32 位哈希
  value: string;  // JSON 序列化后的值
  dist: number;   // 到理想桶的环形距离
}

export type SlotOrNull = Slot | null;

export interface ProbeStep {
  slot: number;
  queryDist: number;
  state: 'empty' | 'match' | 'continue' | 'stop-distance';
  slotKey?: string;
  slotDist?: number;
}

export interface TraceEvent {
  type: 'swap' | 'shift' | 'grow' | 'insert' | 'update' | 'remove' | 'noop';
  [k: string]: unknown;
}

export interface OpResult {
  changed: boolean;          // 是否发生了实际数据修改
  probes: ProbeStep[];
  events: TraceEvent[];
  sizeBefore: number;
  sizeAfter: number;
  capacityBefore: number;
  capacityAfter: number;
}

export class TableFullError extends Error {
  code = 'TABLE_FULL';
  constructor(public capacity: number, public maxCapacity: number) {
    super(`负载超过 3/4 且容量 ${capacity} 已达上限 ${maxCapacity}，拒绝插入`);
  }
}

export const MIN_CAPACITY = 4;
export const DEFAULT_MAX_CAPACITY = 1 << 20;

export function normalizeCapacity(n: number): number {
  let c = MIN_CAPACITY;
  while (c < n) c <<= 1;
  return c;
}

export class RobinHoodTable {
  capacity: number;
  readonly maxCapacity: number;
  size = 0;
  slots: SlotOrNull[];

  constructor(capacity = MIN_CAPACITY, maxCapacity = DEFAULT_MAX_CAPACITY) {
    this.capacity = normalizeCapacity(capacity);
    this.maxCapacity = Math.max(this.capacity, normalizeCapacity(maxCapacity));
    this.slots = new Array<SlotOrNull>(this.capacity).fill(null);
  }

  private homeOf(hash: number): number {
    return bucketOf(hash, this.capacity);
  }

  // 环形距离：从理想桶 home 到槽位 i 沿探测方向的步数
  private ringDist(home: number, i: number): number {
    return (i - home + this.capacity) % this.capacity;
  }

  private findSlot(key: string, hash: number): { index: number; probes: ProbeStep[] } {
    const probes: ProbeStep[] = [];
    const home = this.homeOf(hash);
    for (let d = 0; d < this.capacity; d++) {
      const i = (home + d) % this.capacity;
      const s = this.slots[i];
      if (s === null) {
        probes.push({ slot: i, queryDist: d, state: 'empty' });
        return { index: -1, probes };
      }
      if (s.key === key && s.hash === hash) {
        probes.push({ slot: i, queryDist: d, state: 'match', slotKey: s.key, slotDist: s.dist });
        return { index: i, probes };
      }
      // 现有元素比查询走得更近 => 键不可能在更后面，提前结束
      if (s.dist < d) {
        probes.push({ slot: i, queryDist: d, state: 'stop-distance', slotKey: s.key, slotDist: s.dist });
        return { index: -1, probes };
      }
      probes.push({ slot: i, queryDist: d, state: 'continue', slotKey: s.key, slotDist: s.dist });
    }
    return { index: -1, probes };
  }

  get(key: string): { found: boolean; value?: string; probes: ProbeStep[] } {
    const hash = fnv1a32(key);
    const { index, probes } = this.findSlot(key, hash);
    if (index < 0) return { found: false, probes };
    return { found: true, value: this.slots[index]!.value, probes };
  }

  private grow(events: TraceEvent[]): void {
    const from = this.capacity;
    const to = from * 2;
    if (to > this.maxCapacity) throw new TableFullError(from, this.maxCapacity);
    const old = this.slots;
    this.capacity = to;
    this.slots = new Array<SlotOrNull>(to).fill(null);
    events.push({ type: 'grow', from, to });
    // 按旧槽位顺序重新插入（无轨迹的裸插入）
    for (const s of old) {
      if (s !== null) this.placeRaw({ ...s, dist: 0 });
    }
  }

  // 裸 Robin Hood 放置，用于扩容重排；槽位中的 dist 会被重算
  private placeRaw(entry: Slot): void {
    let hash = entry.hash;
    let cur: Slot = { key: entry.key, hash, value: entry.value, dist: 0 };
    let i = this.homeOf(hash);
    for (;;) {
      const s = this.slots[i];
      if (s === null) {
        this.slots[i] = cur;
        return;
      }
      if (cur.dist > s.dist) {
        const tmp = s;
        this.slots[i] = cur;
        cur = tmp;
      }
      cur.dist++;
      i = (i + 1) % this.capacity;
    }
  }

  put(key: string, value: string): OpResult {
    const events: TraceEvent[] = [];
    const sizeBefore = this.size;
    const capacityBefore = this.capacity;
    const hash = fnv1a32(key);

    const found = this.findSlot(key, hash);
    if (found.index >= 0) {
      // 更新已有键：只替换值，不增加元素数
      this.slots[found.index]!.value = value;
      events.push({ type: 'update', slot: found.index, key });
      return {
        changed: true, probes: found.probes, events,
        sizeBefore, sizeAfter: this.size,
        capacityBefore, capacityAfter: this.capacity,
      };
    }

    // 新键：若插入会使负载超过 3/4，先扩容
    if ((this.size + 1) * 4 > this.capacity * 3) {
      this.grow(events); // 达到上限时抛 TableFullError，明确拒绝
    }

    let cur: Slot = { key, hash, value, dist: 0 };
    let i = this.homeOf(hash);
    const probes: ProbeStep[] = [];
    for (;;) {
      const s = this.slots[i];
      if (s === null) {
        this.slots[i] = cur;
        this.size++;
        probes.push({ slot: i, queryDist: cur.dist, state: 'empty' });
        events.push({ type: 'insert', slot: i, key, dist: cur.dist });
        break;
      }
      probes.push({ slot: i, queryDist: cur.dist, state: 'continue', slotKey: s.key, slotDist: s.dist });
      if (cur.dist > s.dist) {
        // 严格大于才交换；距离相同保持既有元素在前
        events.push({ type: 'swap', slot: i, incoming: { key: cur.key, dist: cur.dist }, evicted: { key: s.key, dist: s.dist } });
        const tmp = s;
        this.slots[i] = cur;
        cur = tmp;
      }
      cur.dist++;
      i = (i + 1) % this.capacity;
    }

    return {
      changed: true, probes, events,
      sizeBefore, sizeAfter: this.size,
      capacityBefore, capacityAfter: this.capacity,
    };
  }

  remove(key: string): OpResult & { found: boolean } {
    const events: TraceEvent[] = [];
    const sizeBefore = this.size;
    const capacityBefore = this.capacity;
    const hash = fnv1a32(key);
    const { index, probes } = this.findSlot(key, hash);
    if (index < 0) {
      events.push({ type: 'noop', reason: 'key-not-found', key });
      return {
        found: false, changed: false, probes, events,
        sizeBefore, sizeAfter: this.size,
        capacityBefore, capacityAfter: this.capacity,
      };
    }

    events.push({ type: 'remove', slot: index, key });
    // 后移删除：把后续 dist>0 的元素逐个前移一格并减距离，无墓碑
    let j = index;
    for (;;) {
      const next = (j + 1) % this.capacity;
      const s = this.slots[next];
      if (s === null || s.dist === 0) {
        this.slots[j] = null;
        break;
      }
      this.slots[j] = { ...s, dist: s.dist - 1 };
      events.push({ type: 'shift', from: next, to: j, key: s.key, distBefore: s.dist, distAfter: s.dist - 1 });
      j = next;
    }
    this.size--;

    return {
      found: true, changed: true, probes, events,
      sizeBefore, sizeAfter: this.size,
      capacityBefore, capacityAfter: this.capacity,
    };
  }

  snapshot(): { capacity: number; maxCapacity: number; size: number; slots: SlotOrNull[] } {
    return {
      capacity: this.capacity,
      maxCapacity: this.maxCapacity,
      size: this.size,
      slots: this.slots.map((s) => (s === null ? null : { ...s })),
    };
  }

  static restore(snap: { capacity: number; maxCapacity: number; slots: SlotOrNull[] }): RobinHoodTable {
    const t = new RobinHoodTable(snap.capacity, snap.maxCapacity);
    t.capacity = snap.capacity;
    t.slots = snap.slots.map((s) => (s === null ? null : { ...s }));
    t.size = snap.slots.filter((s) => s !== null).length;
    return t;
  }

  // 独立不变量核验：距离正确、键唯一、计数一致
  verify(): { ok: boolean; errors: string[] } {
    const errors: string[] = [];
    const seen = new Set<string>();
    let count = 0;
    for (let i = 0; i < this.capacity; i++) {
      const s = this.slots[i];
      if (s === null) continue;
      count++;
      if (seen.has(s.key)) errors.push(`重复键: ${s.key}`);
      seen.add(s.key);
      const expect = this.ringDist(this.homeOf(s.hash), i);
      if (s.dist !== expect) errors.push(`槽 ${i} 键 ${s.key} 距离 ${s.dist} != 期望 ${expect}`);
      if (s.hash !== fnv1a32(s.key)) errors.push(`槽 ${i} 键 ${s.key} 哈希不一致`);
    }
    if (count !== this.size) errors.push(`元素计数 ${this.size} != 实际 ${count}`);
    return { ok: errors.length === 0, errors };
  }
}
