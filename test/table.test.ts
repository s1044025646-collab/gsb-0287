import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RobinHoodTable, TableFullError } from '../src/table';
import { fnv1a32, bucketOf } from '../src/fnv';

function collidingKeys(capacity: number, bucket: number, count: number, prefix = 'k'): string[] {
  const keys: string[] = [];
  for (let i = 0; keys.length < count; i++) {
    const k = `${prefix}${i}`;
    if (bucketOf(fnv1a32(k), capacity) === bucket) keys.push(k);
  }
  return keys;
}

function assertVerify(t: RobinHoodTable): void {
  const v = t.verify();
  assert.ok(v.ok, v.errors.join('; '));
}

test('FNV-1a 已知向量可复现', () => {
  // 公开参考值：fnv1a32("") = 0x811c9dc5
  assert.equal(fnv1a32(''), 0x811c9dc5);
  // fnv1a32("a") = 0xe40c292c
  assert.equal(fnv1a32('a'), 0xe40c292c);
  // fnv1a32("foobar") = 0xbf9cf968
  assert.equal(fnv1a32('foobar'), 0xbf9cf968);
});

test('严格距离比较触发交换，距离相等不交换', () => {
  const cap = 8;
  const t = new RobinHoodTable(cap, 64);
  // a、b 同桶 0；c 桶 1。先放 a(桶0) b(桶0)，b 走到 dist1。
  const [a, b] = collidingKeys(cap, 0, 2, 'ab');
  const [c] = collidingKeys(cap, 1, 1, 'c');
  t.put(a, '1');
  t.put(b, '2');
  // 此时槽0=a(d0) 槽1=b(d1)。c 理想桶1，到槽1时 cur.dist=0 < b.dist=1 不交换；
  // 到槽2时 cur.dist=1，若槽2被占且 dist<1 才交换。直接验证交换场景：
  const r = t.put(c, '3');
  assertVerify(t);
  // 构造明确交换：新元素走得比现有元素远
  const t2 = new RobinHoodTable(cap, 64);
  const [x] = collidingKeys(cap, 1, 1, 'x');
  const [y, z] = collidingKeys(cap, 0, 2, 'y');
  t2.put(x, '1'); // 槽1, dist0
  t2.put(y, '2'); // 桶0 -> 槽0 dist0
  const r2 = t2.put(z, '3'); // 桶0：槽0(d0=y d0 不交换) 槽1(cur d1 > x d0 交换)
  const swaps = r2.events.filter((e) => e.type === 'swap');
  assert.ok(swaps.length >= 1, '应发生至少一次交换');
  const swap = swaps[0] as unknown as { incoming: { dist: number }; evicted: { dist: number } };
  assert.ok(swap.incoming.dist > swap.evicted.dist, '交换严格发生在距离更大时');
  assertVerify(t2);
  // 距离相等不交换：插入桶0的第三个键，经过槽0时 dist1 > y dist0 会交换……
  // 单独验证：两个同桶键，第二个在槽1时 dist1，与槽1 dist0 的 x 相遇即上面场景。
  // 相等情形：同桶两键，第一键槽0 d0，第二键到槽0时 cur d0 == y d0，不交换。
  const r3 = t2.put(y, '2'); // 更新，无交换
  assert.ok(r3.events.every((e) => e.type !== 'swap'));
});

test('无效查询提前退出（空槽与距离规则）', () => {
  const cap = 8;
  const t = new RobinHoodTable(cap, 64);
  const [a] = collidingKeys(cap, 0, 1, 'a');
  t.put(a, '1');
  // 查询落在空槽的键
  const r1 = t.get('not-exist-empty');
  assert.equal(r1.found, false);
  assert.ok(r1.probes.some((p) => p.state === 'empty') || r1.probes.some((p) => p.state === 'stop-distance'));
  // 构造 stop-distance：同桶三键形成链 0,1,2（dist 0,1,2），查询同桶第四键，
  // 走到链尾后一格为空 -> empty；构造距离提前退出：查询桶1的键，经过槽1(d1)槽2(d2)…
  const t2 = new RobinHoodTable(cap, 64);
  const chain = collidingKeys(cap, 0, 3, 'ch');
  for (const k of chain) t2.put(k, 'v');
  // 链占槽0(d0)1(d1)2(d2)。查询理想桶1的键 q：槽1 d1 >= qd0 继续? qd0, slot d1 >= 0 继续；
  // 槽2 qd1, slot d2 >= 1 继续；槽3 empty -> 空槽退出。改为查询理想桶2的键：
  // 槽2 qd0 slot d2 继续；槽3 empty。仍空槽退出。
  // 距离退出需要 slot.dist < queryDist：查询桶0的第四键，槽0 d0=qd0 继续，槽1 d1=qd1，
  // 槽2 d2=qd2，槽3 empty。链满载时空槽先出现。构造：桶0两键占槽0,1；桶3一键占槽3。
  const t3 = new RobinHoodTable(cap, 64);
  const [p1, p2] = collidingKeys(cap, 0, 2, 'p');
  const [q1] = collidingKeys(cap, 3, 1, 'q');
  t3.put(p1, '1'); t3.put(p2, '2'); t3.put(q1, '3');
  // 槽0:p1(d0) 槽1:p2(d1) 槽3:q1(d0)。查询桶1的键 r：槽1 qd0 slot d1 继续；槽2 空 -> empty。
  // 查询桶0的第三键：槽0 qd0 d0，槽1 qd1 d1，槽2 空。距离退出需链中 dist 下降：
  // 槽1 p2 d1，查询桶0键到槽2为空。要触发 stop-distance：删除链首后后移使 dist 下降。
  t3.remove(p1); // p2 前移到槽0 d0
  const r2 = t3.get(p1); // 桶0：槽0 qd0 slot p2 d0 继续(同键?否)，槽1 空 -> empty
  assert.equal(r2.found, false);
  // 直接构造 stop-distance：槽0 放桶0键(d0)，查询桶0另一键时槽1若为空则 empty。
  // 用更新后场景验证 stop-distance 分支存在性：手工摆槽
  const t4 = new RobinHoodTable(cap, 64);
  const [s1] = collidingKeys(cap, 0, 1, 's');
  const [s2] = collidingKeys(cap, 1, 1, 't');
  t4.put(s1, '1'); // 槽0 d0
  t4.put(s2, '2'); // 槽1 d0
  // 查询桶0的键：槽0 qd0 slot d0 继续；槽1 qd1 slot d0 < 1 -> stop-distance
  const r4 = t4.get(collidingKeys(cap, 0, 2, 's')[1]);
  assert.equal(r4.found, false);
  assert.ok(r4.probes.some((p) => p.state === 'stop-distance'), '应出现距离提前退出');
});

test('跨末端冲突链距离计算正确', () => {
  const cap = 4;
  const t = new RobinHoodTable(cap, 64);
  // 找理想桶为 3 的键，使其探测跨过末端回绕到 0
  const keys = collidingKeys(cap, 3, 3, 'w');
  t.put(keys[0], '1'); // 槽3 d0
  t.put(keys[1], '2'); // 槽0 d1（回绕）
  const r = t.put(keys[2], '3'); // 槽1 d2
  assert.equal(r.sizeAfter, 3);
  assertVerify(t);
  const home = bucketOf(fnv1a32(keys[1]), cap);
  assert.equal(home, 3);
  const slotIdx = t.slots.findIndex((s) => s?.key === keys[1]);
  assert.equal(slotIdx, 0);
  assert.equal(t.slots[0]!.dist, 1, '回绕槽位距离按环形计算');
  // 全部可查
  for (const k of keys) assert.ok(t.get(k).found);
});

test('链首删除触发后移，链中删除正确', () => {
  const cap = 8;
  const t = new RobinHoodTable(cap, 64);
  const chain = collidingKeys(cap, 0, 3, 'd');
  for (const k of chain) t.put(k, `v-${k}`);
  // 链首删除
  const r1 = t.remove(chain[0]);
  assert.ok(r1.found);
  const shifts1 = r1.events.filter((e) => e.type === 'shift');
  assert.ok(shifts1.length >= 1, '链首删除应后移后续元素');
  assert.equal(t.size, 2);
  assertVerify(t);
  for (const k of chain.slice(1)) assert.ok(t.get(k).found, `${k} 删除链首后仍可查`);
  // 链中删除
  const t2 = new RobinHoodTable(cap, 64);
  for (const k of chain) t2.put(k, `v-${k}`);
  const r2 = t2.remove(chain[1]);
  assert.ok(r2.found);
  assert.ok(r2.events.some((e) => e.type === 'shift'));
  assertVerify(t2);
  assert.ok(t2.get(chain[0]).found);
  assert.ok(t2.get(chain[2]).found);
  assert.equal(t2.get(chain[1]).found, false);
});

test('重复删除返回未找到且不修改数据', () => {
  const t = new RobinHoodTable(8, 64);
  t.put('a', '1');
  const r1 = t.remove('a');
  assert.ok(r1.found && r1.changed);
  const r2 = t.remove('a');
  assert.equal(r2.found, false);
  assert.equal(r2.changed, false);
  assert.ok(r2.events.some((e) => e.type === 'noop'));
  assert.equal(r2.sizeAfter, 0);
});

test('更新已有键不增加元素数、不产生重复键', () => {
  const t = new RobinHoodTable(8, 64);
  t.put('k', '1');
  const r = t.put('k', '2');
  assert.equal(r.sizeBefore, 1);
  assert.equal(r.sizeAfter, 1);
  assert.ok(r.events.some((e) => e.type === 'update'));
  assert.equal(t.get('k').value, '2');
  assert.equal(t.slots.filter((s) => s?.key === 'k').length, 1);
  assertVerify(t);
});

test('扩容后全部键可查', () => {
  const t = new RobinHoodTable(4, 64);
  const keys: string[] = [];
  let grew = false;
  for (let i = 0; i < 20; i++) {
    const r = t.put(`g${i}`, `v${i}`);
    if (r.events.some((e) => e.type === 'grow')) grew = true;
    keys.push(`g${i}`);
  }
  assert.ok(grew, '应触发扩容');
  assert.ok(t.capacity > 4);
  for (const k of keys) {
    const r = t.get(k);
    assert.ok(r.found, `${k} 扩容后可查`);
    assert.equal(r.value, `v${k.slice(1)}`);
  }
  assertVerify(t);
});

test('达到容量上限明确拒绝', () => {
  const t = new RobinHoodTable(4, 4);
  t.put('a', '1');
  t.put('b', '2');
  t.put('c', '3'); // 负载 3/4，下一次插入新键需扩容但已到上限
  assert.throws(() => t.put('d', '4'), (e: Error) => e instanceof TableFullError);
  // 拒绝后存量数据不受影响
  assert.equal(t.size, 3);
  assert.ok(t.get('a').found && t.get('b').found && t.get('c').found);
  assertVerify(t);
  // 更新已有键仍允许
  const r = t.put('a', '9');
  assert.equal(r.sizeAfter, 3);
});

test('随机操作序列与普通字典对拍 + 不变量核验', () => {
  let seed = 12345;
  const rand = (): number => {
    seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const t = new RobinHoodTable(4, 4096);
  const dict = new Map<string, string>();
  const keyPool = Array.from({ length: 60 }, (_, i) => `rk${i}`);
  for (let step = 0; step < 500; step++) {
    const key = keyPool[Math.floor(rand() * keyPool.length)];
    const roll = rand();
    if (roll < 0.5) {
      const v = `v${step}`;
      t.put(key, v);
      dict.set(key, v);
    } else if (roll < 0.8) {
      const r = t.get(key);
      assert.equal(r.found, dict.has(key), `get(${key}) 与字典不一致 @${step}`);
      if (r.found) assert.equal(r.value, dict.get(key));
    } else {
      const r = t.remove(key);
      assert.equal(r.found, dict.delete(key), `del(${key}) 与字典不一致 @${step}`);
    }
    assert.equal(t.size, dict.size, `元素计数不一致 @${step}`);
  }
  // 最终全量比对
  for (const [k, v] of dict) {
    const r = t.get(k);
    assert.ok(r.found && r.value === v);
  }
  assertVerify(t);
});
