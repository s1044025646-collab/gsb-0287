import { Store } from "./store";
import { CapacityExceededError, SlotEntry } from "./table";

function printSlots(slots: (SlotEntry | null)[]): void {
  slots.forEach((s, i) => {
    if (!s) console.log(`  [${i}] <空>`);
    else console.log(`  [${i}] key=${JSON.stringify(s.key)} hash=${s.hash} dist=${s.dist} value=${JSON.stringify(s.value)}`);
  });
}

function usage(): void {
  console.log(`用法: node dist/src/cli.js <命令> [参数]
命令:
  create <名称> [初始容量] [容量上限]   创建哈希表
  list                                  列出所有表
  put <表id> <键> <JSON值>              插入或更新
  get <表id> <键>                       查询
  del <表id> <键>                       删除（后移）
  slots <表id>                          查看槽位布局
  ops <表id>                            读取操作轨迹
  export <表id>                         导出快照 JSON
  replay <表id> [到序号]                历史回放`);
}

function main(): void {
  const [, , cmd, ...args] = process.argv;
  const store = new Store();
  try {
    switch (cmd) {
      case "create": {
        const [name, init, max] = args;
        if (!name) throw new Error("缺少表名称");
        const meta = store.createTable(
          name,
          init ? Number(init) : undefined,
          max ? Number(max) : undefined
        );
        console.log(`已创建表 id=${meta.id} 容量=${meta.capacity} 上限=${meta.maxCapacity}`);
        break;
      }
      case "list": {
        for (const t of store.listTables()) {
          console.log(`id=${t.id} name=${t.name} size=${t.size} capacity=${t.capacity} max=${t.maxCapacity}`);
        }
        break;
      }
      case "put": {
        const [id, key, raw] = args;
        const table = mustLoad(store, id);
        const value = JSON.parse(raw);
        const trace = table.set(key, value);
        const seq = store.recordOp(Number(id), "set", key, value, trace, table);
        console.log(`seq=${seq} size ${trace.sizeBefore} -> ${trace.sizeAfter}`);
        printEvents(trace.events);
        break;
      }
      case "get": {
        const [id, key] = args;
        const table = mustLoad(store, id);
        const { trace, value, found } = table.get(key);
        store.recordOp(Number(id), "get", key, undefined, trace, table);
        printEvents(trace.events);
        console.log(found ? `命中 value=${JSON.stringify(value)}` : "未命中");
        break;
      }
      case "del": {
        const [id, key] = args;
        const table = mustLoad(store, id);
        const { trace, removed } = table.delete(key);
        store.recordOp(Number(id), "delete", key, undefined, trace, table);
        printEvents(trace.events);
        console.log(removed ? `已删除，size ${trace.sizeBefore} -> ${trace.sizeAfter}` : "键不存在，未修改");
        break;
      }
      case "slots": {
        const table = mustLoad(store, args[0]);
        console.log(`capacity=${table.capacity} size=${table.size}`);
        printSlots(table.dumpSlots());
        break;
      }
      case "ops": {
        for (const rec of store.listOps(Number(args[0]))) {
          console.log(`seq=${rec.seq} op=${rec.op} key=${rec.key ?? "-"}`);
          printEvents(rec.trace.events);
        }
        break;
      }
      case "export": {
        const snap = store.exportSnapshot(Number(args[0]));
        if (!snap) throw new Error("表不存在");
        console.log(JSON.stringify(snap, null, 2));
        break;
      }
      case "replay": {
        const steps = store.replay(Number(args[0]), args[1] ? Number(args[1]) : undefined);
        for (const s of steps) {
          console.log(`--- seq=${s.seq} ${s.op ? `${s.op.op} ${s.op.key ?? ""}` : "(初始)"}`);
          printSlots(s.slots);
        }
        break;
      }
      default:
        usage();
        if (cmd) process.exitCode = 1;
    }
  } catch (e: any) {
    if (e instanceof CapacityExceededError) {
      console.error(`错误 [CAPACITY_EXCEEDED]: ${e.message}`);
    } else {
      console.error(`错误: ${e.message}`);
    }
    process.exitCode = 1;
  } finally {
    store.close();
  }
}

function mustLoad(store: Store, idArg: string) {
  const table = store.loadTable(Number(idArg));
  if (!table) throw new Error(`表 ${idArg} 不存在`);
  return table;
}

function printEvents(events: any[]): void {
  for (const e of events) {
    console.log(`  ${e.type}: ${JSON.stringify(e)}`);
  }
}

main();
