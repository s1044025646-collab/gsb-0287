import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Store } from "../src/store";

function tmpDb(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "rh-")), "test.db");
}

test("重启后快照恢复查询与槽位布局", () => {
  const db = tmpDb();
  const store = new Store(db);
  const meta = store.createTable("t1", 4, 64);
  const table = store.loadTable(meta.id)!;
  for (let i = 0; i < 6; i++) {
    const trace = table.set(`k${i}`, { i });
    store.recordOp(meta.id, "set", `k${i}`, { i }, trace, table);
  }
  const before = table.dumpSlots();
  store.close();

  const store2 = new Store(db);
  const restored = store2.loadTable(meta.id)!;
  assert.deepEqual(restored.dumpSlots(), before);
  for (let i = 0; i < 6; i++) {
    assert.deepEqual(restored.get(`k${i}`).value, { i });
  }
  store2.close();
});

test("历史回放逐步重建槽位", () => {
  const db = tmpDb();
  const store = new Store(db);
  const meta = store.createTable("t2", 4, 64);
  const table = store.loadTable(meta.id)!;
  const keys = ["a", "b", "c", "d", "e"];
  for (const k of keys) {
    const trace = table.set(k, k);
    store.recordOp(meta.id, "set", k, k, trace, table);
  }
  const d = table.delete("b");
  store.recordOp(meta.id, "delete", "b", undefined, d.trace, table);

  const steps = store.replay(meta.id);
  assert.equal(steps.length, 7); // 初始 + 5 set + 1 delete
  const final = steps[steps.length - 1].slots;
  assert.deepEqual(final, table.dumpSlots());
  // 回放中间步骤：前 3 个 set 后应有 3 个元素
  const mid = steps[3].slots.filter((s) => s !== null);
  assert.equal(mid.length, 3);
  store.close();
});
