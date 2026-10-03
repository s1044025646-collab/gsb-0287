import path from 'node:path';
import { Store } from './db';
import { startServer } from './server';

const DATA_DIR = path.join(process.cwd(), 'data');
const DB_PATH = process.env.RH_DB ?? path.join(DATA_DIR, 'robinhood.db');

function print(x: unknown): void {
  console.log(JSON.stringify(x, null, 2));
}

function usage(): void {
  console.log(`用法: node dist/src/cli.js <命令> [参数]
  serve [--port N]                          启动 HTTP API（默认端口 0 = 自动选空闲端口）
  create <name> [capacity] [maxCapacity]    创建实验表
  list                                      列出实验
  put <id> <key> <jsonValue>                插入或更新
  get <id> <key>                            查询
  del <id> <key>                            删除（后移）
  slots <id>                                查看槽位布局
  ops <id>                                  读取操作轨迹
  export <id>                               导出快照
  replay <id> [toSeq]                       历史回放
环境变量: RH_DB 指定数据库文件，PORT 指定服务端口`);
}

async function main(): Promise<void> {
  const [, , cmd, ...args] = process.argv;
  if (!cmd || cmd === 'help' || cmd === '--help') return usage();

  const store = new Store(DB_PATH);
  try {
    switch (cmd) {
      case 'serve': {
        const idx = args.indexOf('--port');
        const port = idx >= 0 ? Number(args[idx + 1]) : Number(process.env.PORT ?? 0);
        const { port: p } = await startServer(store, port);
        console.log(`API 服务已启动: http://127.0.0.1:${p}  (数据库: ${DB_PATH})`);
        return; // 保持进程
      }
      case 'create':
        print(store.createExperiment(args[0] ?? 'experiment',
          args[1] ? Number(args[1]) : undefined as unknown as number,
          args[2] ? Number(args[2]) : undefined as unknown as number));
        break;
      case 'list':
        print(store.listExperiments());
        break;
      case 'put':
        print(store.put(Number(args[0]), args[1], JSON.parse(args[2])));
        break;
      case 'get':
        print(store.get(Number(args[0]), args[1]));
        break;
      case 'del':
        print(store.remove(Number(args[0]), args[1]));
        break;
      case 'slots':
        print(store.slots(Number(args[0])));
        break;
      case 'ops':
        print(store.operations(Number(args[0])));
        break;
      case 'export':
        print(store.exportSnapshot(Number(args[0])));
        break;
      case 'replay':
        print(store.replay(Number(args[0]), args[1] ? Number(args[1]) : undefined));
        break;
      default:
        console.error(`未知命令: ${cmd}`);
        usage();
        process.exitCode = 1;
    }
  } finally {
    if (cmd !== 'serve') store.close();
  }
}

main().catch((e) => {
  console.error(JSON.stringify({ ok: false, error: { code: e.code ?? 'INTERNAL', message: e.message } }));
  process.exitCode = 1;
});
