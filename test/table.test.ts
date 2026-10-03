import { test } from "node:test";
import assert from "node:assert/strict";
import { RobinHoodTable, CapacityExceededError, SlotEntry } from "../src/table";
import { fnv1a32, bucketOf } from "../src/fnv";

/** 找到哈希到指定桶的键。 */
function keysForBucket(bucket: number, capacity: number, count: number, prefix = "k"): string[] {
  const keys: string[] = [];
  for (let i = 0; keys.length < count; i++) {
    const k = `${prefix}-${i}`;
    if (bucketOf(fnv1a32(k), capacity) === bucket) keys.push(k);
  }
  return keys;
}

/** 独立核验：距离正确、键唯一、元素计数正确。 */
function verifyInvariants(table: RobinHoodTable, expectedSize: number): void {
  const slots = table.dumpSlots();
  const cap = table.capacity;
  const seen = new Set<string>();
  let count = 0;
  for (let i = 0; i < cap; i++) {
    const s = slots[i];
    if (!s) continue;
    count++;
    assert.ok(!seen.has(s.key), `重复键 ${s.key}`);
    seen.add(s.key);
    const expectedDist = (i - bucketOf(s.hash, cap) + cap) % cap;
    assert.equal(s.dist, expectedDist, `键 ${s.key} 在槽 ${i} 的距离应为 ${expectedDist}，实际 ${s.dist}`);
    assert.equal(s.hash, fnv1a32(s.key));
  }
  assert.equal(count, expectedSize, "槽位中的元素数");
  assert.equal(table.size, expectedSize, "table.size");
}

test("FNV-1a 已知向量可复现", () => {
  // FNV-1a 32bit 公开测试向量
  assert.equal(fnv1a32(""), 0x811c9dc5);
  assert.equal(fnv1a32("a"), 0xe40c292c);
  assert.equal(fnv1a32("foobar"), 0xbf9cf968);
});

test("同桶冲突键触发严格距离交换", () => {
  const t = new RobinHoodTable(8, 64);
  // a 占槽0(dist=0)，x 理想桶1占槽1(dist=0)。
  // c 理想桶0：走到槽1时 dist=1 > x.dist=0，触发交换，x 被换出继续探测。
  const [a] = keysForBucket(0, 8, 1, "a");
  const [x] = keysForBucket(1, 8, 1, "x");
  const [c] = keysForBucket(0, 8, 1, "c");
  t.set(a, 1);
  t.set(x, 2);
  const trace = t.set(c, 3);
  const swaps = trace.events.filter((e) => e.type === "swap");
  assert.equal(swaps.length, 1, "应发生一次交换");
  const swap = swaps[0] as any;
  assert.equal(swap.slot, 1);
  assert.equal(swap.incomingKey, c);
  assert.equal(swap.evictedKey, x);
  assert.ok(swap.incomingDist > swap.evictedDist, "严格大于才交换");
  // 交换后 c 在槽1(dist=0)，x 被换出到槽2(dist=1)
  const slots = t.dumpSlots();
  assert.equal(slots[1]!.key, c);
  assert.equal(slots[1]!.dist, 1);
  assert.equal(slots[2]!.key, x);
  assert.equal(slots[2]!.dist, 1);
  verifyInvariants(t, 3);
});

test("距离相等时不交换，既有元素在前", () => {
  const t = new RobinHoodTable(8, 64);
  const [a, b] = keysForBucket(0, 8, 2);
  t.set(a, 1);
  t.set(b, 2);
  const slots = t.dumpSlots();
  // a 在槽0(dist=0)，b 在槽1(dist=1)。插入第三个同桶键 c，
  // 在槽1处 c.dist=1 == b.dist=1，不应交换。
  const c = keysForBucket(0, 8, 3).filter((k) => k !== a && k !== b)[0];
  const trace = t.set(c, 3);
  const swapAt1 = trace.events.find((e) => e.type === "swap" && (e as any).slot === 1);
  assert.equal(swapAt1, undefined, "距离相等不应交换");
  assert.equal(t.dumpSlots()[1]!.key, b);
  verifyInvariants(t, 3);
});

test("无效查询提前退出（early-exit）", () => {
  const t = new RobinHoodTable(8, 64);
  const [a] = keysForBucket(0, 8, 1);
  t.set(a, 1);
  // 找一个理想桶为 0 但不存在的键：它会在槽1遇到空槽停止（empty-slot）
  const missing = keysForBucket(0, 8, 2).filter((k) => k !== a)[0];
  const r1 = t.get(missing);
  assert.equal(r1.found, false);
  assert.ok(r1.trace.events.some((e) => e.type === "miss"));

  // 构造 early-exit：槽1放 dist=0 的元素，查询理想桶0、行走到槽1时 dist=1 > 0
  const t2 = new RobinHoodTable(8, 64);
  const [x] = keysForBucket(1, 8, 1, "x");
  t2.set(x, 1); // x 在槽1, dist=0
  const [y] = keysForBucket(0, 8, 1, "y");
  const r2 = t2.get(y); // y 理想桶0，槽0空 -> empty-slot；需槽0有元素
  const [z] = keysForBucket(0, 8, 1, "z");
  t2.set(z, 2); // z 在槽0 dist=0
  const r3 = t2.get(y);
  assert.equal(r3.found, false);
  const miss = r3.trace.events.find((e) => e.type === "miss") as any;
  assert.equal(miss.reason, "early-exit", "槽1元素 dist=0 小于查询 dist=1，应提前退出");
});

test("跨末端冲突链距离计算正确", () => {
  const t = new RobinHoodTable(8, 64);
  // 找 3 个理想桶为 7 的键，它们会占据 7,0,1（环绕）
  const keys = keysForBucket(7, 8, 3);
  keys.forEach((k, i) => t.set(k, i));
  const slots = t.dumpSlots();
  assert.equal(slots[7]!.key, keys[0]);
  assert.equal(slots[7]!.dist, 0);
  assert.equal(slots[0]!.key, keys[1]);
  assert.equal(slots[0]!.dist, 1, "环绕到槽0，距离应为1而非线性地址差");
  assert.equal(slots[1]!.key, keys[2]);
  assert.equal(slots[1]!.dist, 2);
  verifyInvariants(t, 3);
  for (const k of keys) assert.ok(t.get(k).found);
});

test("链首删除触发后移", () => {
  const t = new RobinHoodTable(8, 64);
  const keys = keysForBucket(0, 8, 3);
  keys.forEach((k, i) => t.set(k, i));
  const { trace, removed } = t.delete(keys[0]);
  assert.ok(removed);
  const shifts = trace.events.filter((e) => e.type === "shift");
  assert.equal(shifts.length, 2, "链首删除应后移两个元素");
  const slots = t.dumpSlots();
  assert.equal(slots[0]!.key, keys[1]);
  assert.equal(slots[0]!.dist, 0);
  assert.equal(slots[1]!.key, keys[2]);
  assert.equal(slots[1]!.dist, 1);
  assert.equal(slots[2], null);
  verifyInvariants(t, 2);
  assert.ok(t.get(keys[1]).found);
  assert.ok(t.get(keys[2]).found);
  assert.ok(!t.get(keys[0]).found);
});

test("链中删除只后移后续元素", () => {
  const t = new RobinHoodTable(8, 64);
  const keys = keysForBucket(0, 8, 3);
  keys.forEach((k, i) => t.set(k, i));
  const { trace } = t.delete(keys[1]);
  const shifts = trace.events.filter((e) => e.type === "shift");
  assert.equal(shifts.length, 1);
  const slots = t.dumpSlots();
  assert.equal(slots[0]!.key, keys[0]);
  assert.equal(slots[1]!.key, keys[2]);
  assert.equal(slots[1]!.dist, 1);
  verifyInvariants(t, 2);
  assert.ok(t.get(keys[2]).found);
});

test("重复删除不报错且不修改数据", () => {
  const t = new RobinHoodTable(8, 64);
  const [a] = keysForBucket(0, 8, 1);
  t.set(a, 1);
  assert.ok(t.delete(a).removed);
  const second = t.delete(a);
  assert.equal(second.removed, false);
  assert.ok(second.trace.events.some((e) => e.type === "noop"));
  assert.equal(t.size, 0);
  verifyInvariants(t, 0);
});

test("更新已有键只替换值", () => {
  const t = new RobinHoodTable(8, 64);
  t.set("k", { v: 1 });
  const trace = t.set("k", { v: 2 });
  assert.equal(t.size, 1);
  assert.ok(trace.events.some((e) => e.type === "update"));
  assert.equal(trace.sizeBefore, 1);
  assert.equal(trace.sizeAfter, 1);
  assert.deepEqual(t.get("k").value, { v: 2 });
  // 无第二份同名键
  assert.equal(t.dumpSlots().filter((s) => s?.key === "k").length, 1);
  verifyInvariants(t, 1);
});

test("扩容后全部键可查", () => {
  const t = new RobinHoodTable(4, 64);
  const keys: string[] = [];
  for (let i = 0; i < 10; i++) keys.push(`resize-key-${i}`);
  const traces = keys.map((k, i) => t.set(k, i));
  assert.ok(traces.some((tr) => tr.events.some((e) => e.type === "resize")), "应发生扩容");
  assert.ok(t.capacity > 4);
  for (let i = 0; i < keys.length; i++) {
    const r = t.get(keys[i]);
    assert.ok(r.found, `扩容后 ${keys[i]} 应可查`);
    assert.equal(r.value, i);
  }
  verifyInvariants(t, keys.length);
});

test("达到容量上限明确拒绝", () => {
  const t = new RobinHoodTable(4, 4);
  t.set("a", 1);
  t.set("b", 2);
  t.set("c", 3); // 负载 3/4，达到上限
  assert.throws(() => t.set("d", 4), CapacityExceededError);
  // 存量元素未被覆盖
  assert.equal(t.get("a").value, 1);
  assert.equal(t.get("b").value, 2);
  assert.equal(t.get("c").value, 3);
  assert.equal(t.size, 3);
  // 更新已有键仍允许
  t.set("a", 10);
  assert.equal(t.get("a").value, 10);
  verifyInvariants(t, 3);
});

test("随机操作序列与普通字典一致", () => {
  let seed = 42;
  const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const t = new RobinHoodTable(4, 256);
  const dict = new Map<string, number>();
  const keyPool = Array.from({ length: 30 }, (_, i) => `rand-${i}`);
  for (let step = 0; step < 500; step++) {
    const key = keyPool[Math.floor(rand() * keyPool.length)];
    const roll = rand();
    if (roll < 0.55) {
      const v = Math.floor(rand() * 1000);
      t.set(key, v);
      dict.set(key, v);
    } else if (roll < 0.8) {
      const removed = t.delete(key).removed;
      assert.equal(removed, dict.delete(key), `删除结果一致: ${key}`);
    } else {
      const r = t.get(key);
      assert.equal(r.found, dict.has(key), `查询命中一致: ${key}`);
      if (r.found) assert.equal(r.value, dict.get(key));
    }
    assert.equal(t.size, dict.size, `第 ${step} 步元素数一致`);
    verifyInvariants(t, dict.size);
  }
  // 最终全量比对
  for (const [k, v] of dict) {
    const r = t.get(k);
    assert.ok(r.found);
    assert.equal(r.value, v);
  }
});
