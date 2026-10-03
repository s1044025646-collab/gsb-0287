import { fnv1a32, bucketOf } from "./fnv";

export interface SlotEntry {
  key: string;
  hash: number;
  value: unknown;
  dist: number;
}

export type TraceEvent =
  | { type: "probe"; slot: number; dist: number; found: "empty" | "entry"; slotDist?: number; slotKey?: string }
  | { type: "swap"; slot: number; incomingKey: string; incomingDist: number; evictedKey: string; evictedDist: number }
  | { type: "insert"; slot: number; key: string; dist: number }
  | { type: "update"; slot: number; key: string }
  | { type: "hit"; slot: number; key: string }
  | { type: "miss"; key: string; reason: "empty-slot" | "early-exit" | "full-scan"; slot: number }
  | { type: "shift"; from: number; to: number; key: string; newDist: number }
  | { type: "delete"; slot: number; key: string }
  | { type: "resize"; from: number; to: number }
  | { type: "noop"; reason: string };

export interface OpTrace {
  op: string;
  key?: string;
  events: TraceEvent[];
  sizeBefore: number;
  sizeAfter: number;
  capacity: number;
  probes: number;
}

export class CapacityExceededError extends Error {
  code = "CAPACITY_EXCEEDED";
  constructor(public maxCapacity: number) {
    super(`插入新键会使负载超过 3/4，且容量已达上限 ${maxCapacity}，拒绝插入`);
  }
}

export const MIN_CAPACITY = 4;
export const MAX_LOAD_NUM = 3;
export const MAX_LOAD_DEN = 4;

function isPowerOfTwo(n: number): boolean {
  return n > 0 && (n & (n - 1)) === 0;
}

export class RobinHoodTable {
  private slots: (SlotEntry | null)[];
  private _size = 0;
  readonly maxCapacity: number;

  constructor(capacity: number = MIN_CAPACITY, maxCapacity: number = 1 << 20) {
    if (!Number.isInteger(capacity) || capacity < MIN_CAPACITY || !isPowerOfTwo(capacity)) {
      throw new Error(`初始容量必须是 >= ${MIN_CAPACITY} 的 2 的幂`);
    }
    if (!Number.isInteger(maxCapacity) || maxCapacity < capacity || !isPowerOfTwo(maxCapacity)) {
      throw new Error("容量上限必须是不小于初始容量的 2 的幂");
    }
    this.slots = new Array(capacity).fill(null);
    this.maxCapacity = maxCapacity;
  }

  get size(): number {
    return this._size;
  }

  get capacity(): number {
    return this.slots.length;
  }

  /** 导出槽位（含空槽），用于查看/快照。 */
  dumpSlots(): (SlotEntry | null)[] {
    return this.slots.map((s) => (s ? { ...s } : null));
  }

  /** 从快照恢复（不做校验，校验由调用方/测试完成）。 */
  static restore(
    capacity: number,
    maxCapacity: number,
    slots: (SlotEntry | null)[]
  ): RobinHoodTable {
    const t = new RobinHoodTable(capacity, maxCapacity);
    t.slots = slots.map((s) => (s ? { ...s } : null));
    t._size = slots.filter((s) => s !== null).length;
    return t;
  }

  private wouldExceedLoad(nextSize: number, capacity: number): boolean {
    return nextSize * MAX_LOAD_DEN > capacity * MAX_LOAD_NUM;
  }

  set(key: string, value: unknown): OpTrace {
    const events: TraceEvent[] = [];
    const sizeBefore = this._size;
    const hash = fnv1a32(key);

    // 先查找是否已存在：更新只替换值，不增加元素数。
    const found = this.locate(key, hash, events);
    if (found !== -1) {
      this.slots[found]!.value = value;
      events.push({ type: "update", slot: found, key });
      return { op: "set", key, events, sizeBefore, sizeAfter: this._size, capacity: this.capacity, probes: 0 };
    }

    // 插入新键前检查负载，必要时扩容。
    if (this.wouldExceedLoad(this._size + 1, this.capacity)) {
      if (this.capacity * 2 > this.maxCapacity) {
        throw new CapacityExceededError(this.maxCapacity);
      }
      this.resize(this.capacity * 2, events);
    }

    let probes = 0;
    let cur: SlotEntry = { key, hash, value, dist: 0 };
    let idx = bucketOf(hash, this.capacity);
    while (true) {
      probes++;
      const slot = this.slots[idx];
      if (!slot) {
        events.push({ type: "probe", slot: idx, dist: cur.dist, found: "empty" });
        this.slots[idx] = cur;
        this._size++;
        events.push({ type: "insert", slot: idx, key: cur.key, dist: cur.dist });
        break;
      }
      events.push({ type: "probe", slot: idx, dist: cur.dist, found: "entry", slotDist: slot.dist, slotKey: slot.key });
      if (cur.dist > slot.dist) {
        // 严格大于才交换；距离相等保持既有元素在前。
        events.push({
          type: "swap",
          slot: idx,
          incomingKey: cur.key,
          incomingDist: cur.dist,
          evictedKey: slot.key,
          evictedDist: slot.dist,
        });
        const tmp = this.slots[idx]!;
        this.slots[idx] = cur;
        cur = { ...tmp };
      }
      idx = (idx + 1) % this.capacity;
      cur.dist++;
      if (cur.dist >= this.capacity) {
        // 理论上负载因子保证不会发生，防御性拒绝，绝不无限探测。
        throw new CapacityExceededError(this.capacity);
      }
    }
    return { op: "set", key, events, sizeBefore, sizeAfter: this._size, capacity: this.capacity, probes };
  }

  /** 返回槽位下标，未找到返回 -1。探测过程写入 events。 */
  private locate(key: string, hash: number, events: TraceEvent[]): number {
    let idx = bucketOf(hash, this.capacity);
    let dist = 0;
    while (true) {
      const slot = this.slots[idx];
      if (!slot) {
        events.push({ type: "probe", slot: idx, dist, found: "empty" });
        events.push({ type: "miss", key, reason: "empty-slot", slot: idx });
        return -1;
      }
      events.push({ type: "probe", slot: idx, dist, found: "entry", slotDist: slot.dist, slotKey: slot.key });
      if (slot.dist < dist) {
        events.push({ type: "miss", key, reason: "early-exit", slot: idx });
        return -1;
      }
      if (slot.hash === hash && slot.key === key) {
        events.push({ type: "hit", slot: idx, key });
        return idx;
      }
      idx = (idx + 1) % this.capacity;
      dist++;
      if (dist >= this.capacity) {
        events.push({ type: "miss", key, reason: "full-scan", slot: idx });
        return -1;
      }
    }
  }

  get(key: string): { trace: OpTrace; value: unknown | undefined; found: boolean } {
    const events: TraceEvent[] = [];
    const hash = fnv1a32(key);
    const idx = this.locate(key, hash, events);
    const found = idx !== -1;
    return {
      trace: {
        op: "get",
        key,
        events,
        sizeBefore: this._size,
        sizeAfter: this._size,
        capacity: this.capacity,
        probes: events.filter((e) => e.type === "probe").length,
      },
      value: found ? this.slots[idx]!.value : undefined,
      found,
    };
  }

  delete(key: string): { trace: OpTrace; removed: boolean } {
    const events: TraceEvent[] = [];
    const sizeBefore = this._size;
    const hash = fnv1a32(key);
    const idx = this.locate(key, hash, events);
    if (idx === -1) {
      events.push({ type: "noop", reason: "键不存在，未发生数据修改" });
      return {
        trace: { op: "delete", key, events, sizeBefore, sizeAfter: this._size, capacity: this.capacity, probes: 0 },
        removed: false,
      };
    }
    events.push({ type: "delete", slot: idx, key });
    // 后移删除：把后续 dist>0 的元素逐个前移一格并减小距离，可跨末端。
    let i = idx;
    while (true) {
      const j = (i + 1) % this.capacity;
      const next = this.slots[j];
      if (!next || next.dist === 0) {
        this.slots[i] = null;
        break;
      }
      this.slots[i] = { ...next, dist: next.dist - 1 };
      events.push({ type: "shift", from: j, to: i, key: next.key, newDist: next.dist - 1 });
      i = j;
    }
    this._size--;
    return {
      trace: {
        op: "delete",
        key,
        events,
        sizeBefore,
        sizeAfter: this._size,
        capacity: this.capacity,
        probes: events.filter((e) => e.type === "probe").length,
      },
      removed: true,
    };
  }

  /** 扩容为两倍，按旧槽位顺序重新插入。 */
  private resize(newCapacity: number, events: TraceEvent[]): void {
    const old = this.slots;
    events.push({ type: "resize", from: old.length, to: newCapacity });
    this.slots = new Array(newCapacity).fill(null);
    const oldSize = this._size;
    this._size = 0;
    for (const entry of old) {
      if (!entry) continue;
      let cur: SlotEntry = { key: entry.key, hash: entry.hash, value: entry.value, dist: 0 };
      let idx = bucketOf(cur.hash, newCapacity);
      while (true) {
        const slot = this.slots[idx];
        if (!slot) {
          this.slots[idx] = cur;
          this._size++;
          break;
        }
        if (cur.dist > slot.dist) {
          const tmp = this.slots[idx]!;
          this.slots[idx] = cur;
          cur = { ...tmp };
        }
        idx = (idx + 1) % newCapacity;
        cur.dist++;
      }
    }
    this._size = oldSize;
  }
}
