// 演示：构造冲突链 -> 删除触发后移 -> 模拟重启后读取快照
import path from 'node:path';
import fs from 'node:fs';
import { Store } from './db';
import { fnv1a32, bucketOf } from './fnv';

const DB_PATH = path.join(process.cwd(), 'data', 'demo.db');

function findCollisions(bucket: number, capacity: number, count: number): string[] {
  const keys: string[] = [];
  for (let i = 0; keys.length < count; i++) {
    const k = `key-${i}`;
    if (bucketOf(fnv1a32(k), capacity) === bucket) keys.push(k);
  }
  return keys;
}

function show(title: string, x: unknown): void {
  console.log(`\n=== ${title} ===`);
  console.log(JSON.stringify(x, null, 2));
}

function main(): void {
  fs.rmSync(DB_PATH, { force: true });
  const store = new Store(DB_PATH);
  const cap = 4;
  const keys = findCollisions(0, cap, 3);
  console.log(`选取同桶键（桶 0，容量 ${cap}）: ${keys.join(', ')}`);

  const exp = store.createExperiment('demo', cap, 64);
  const id = exp.id;

  for (const k of keys) {
    const r = store.put(id, k, { n: k });
    show(`插入 ${k}`, { events: r.events, probes: r.probes });
  }
  show('冲突链形成后的槽位', store.slots(id));

  const del = store.remove(id, keys[0]);
  show(`删除链首 ${keys[0]}（观察 shift 事件）`, del.events);
  show('删除后的槽位', store.slots(id));

  show('删除后查询链尾仍命中', store.get(id, keys[2]));

  // 模拟重启：关闭并用同一数据库文件重新打开
  store.close();
  console.log('\n--- 模拟重启：重新打开数据库 ---');
  const store2 = new Store(DB_PATH);
  show('重启后读取快照', store2.exportSnapshot(id));
  show('重启后查询结果一致', store2.get(id, keys[2]));
  store2.close();
}

main();
