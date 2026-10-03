/**
 * 演示：构造冲突链 -> 删除并观察后移 -> 模拟重启后读取快照。
 */
import { Store } from "./store";
import { fnv1a32, bucketOf } from "./fnv";
import { SlotEntry } from "./table";

function printSlots(slots: (SlotEntry | null)[]): void {
  slots.forEach((s, i) => {
    if (!s) console.log(`  [${i}] <空>`);
    else console.log(`  [${i}] key=${JSON.stringify(s.key)} dist=${s.dist} value=${JSON.stringify(s.value)}`);
  });
}

function findCollidingKeys(bucket: number, capacity: number, count: number): string[] {
  const keys: string[] = [];
  for (let i = 0; keys.length < count; i++) {
    const k = `key-${i}`;
    if (bucketOf(fnv1a32(k), capacity) === bucket) keys.push(k);
  }
  return keys;
}

function main(): void {
  const dbPath = process.argv.find((a) => a.startsWith("--db="))?.split("=")[1];
  const store = new Store(dbPath);
  const capacity = 8;

  console.log("== 1. 创建表并构造同桶冲突链 ==");
  const meta = store.createTable("demo", capacity, 64);
  const table = store.loadTable(meta.id)!;
  const keys = findCollidingKeys(0, capacity, 4);
  console.log(`同桶键(桶0): ${keys.join(", ")}`);
  for (const k of keys) {
    const trace = table.set(k, { n: k });
    store.recordOp(meta.id, "set", k, { n: k }, trace, table);
  }
  printSlots(table.dumpSlots());

  console.log("\n== 2. 删除链中元素，观察后移 ==");
  const victim = keys[1];
  const { trace } = table.delete(victim);
  store.recordOp(meta.id, "delete", victim, undefined, trace, table);
  for (const e of trace.events) {
    if (e.type === "shift") console.log(`  后移: ${e.key} 从槽 ${e.from} -> ${e.to}, dist=${e.newDist}`);
    if (e.type === "delete") console.log(`  删除: ${e.key} 于槽 ${e.slot}`);
  }
  printSlots(table.dumpSlots());

  console.log("\n== 3. 模拟重启：重新打开数据库读取快照 ==");
  store.close();
  const store2 = new Store(dbPath);
  const restored = store2.loadTable(meta.id)!;
  printSlots(restored.dumpSlots());
  for (const k of keys) {
    if (k === victim) continue;
    const r = restored.get(k);
    console.log(`  查询 ${k}: ${r.found ? `命中 ${JSON.stringify(r.value)}` : "未命中(错误!)"}`);
  }
  console.log(`  查询已删除的 ${victim}: ${restored.get(victim).found ? "命中(错误!)" : "未命中(正确)"}`);
  store2.close();
  console.log("\n演示完成。");
}

main();
