# Robin Hood 哈希表探测与后移删除回放实验后端

一个可解释的开放寻址哈希表实验服务：保存字符串键与简单 JSON 值，逐步展示冲突、元素交换、查询提前结束和删除后移动。它是数据结构教学模型，**不是**通用数据库、分布式分片或性能基准平台。

核心键值存储用槽位数组自行实现（`src/table.ts`），不使用 `Map`、普通对象或 SQLite 主键查询替代查找算法；SQLite 仅用于保存实验参数、操作序列与快照。

## 环境要求

- Windows 本地，Node.js >= 22.5（使用内置 `node:sqlite` 与 `node:http`，无原生编译依赖）
- 不依赖 Docker、WSL、付费服务或外部在线 API

## 快速开始

```powershell
npm install        # 仅安装 typescript 与 @types/node
npm run build      # 编译到 dist/
npm test           # 构建并运行全部测试
npm start          # 启动 API 服务（默认端口 0 = 自动选择空闲端口）
npm run demo       # 演示：冲突链 -> 删除后移 -> 模拟重启读快照
```

数据目录为项目内 `data/`（可用环境变量 `RH_DB` 指定数据库文件，`PORT` 指定端口）。

## 核心规则

### 哈希（公开固定，可复现）

FNV-1a 32 位，对键的 UTF-8 字节计算：

```
h = 2166136261 (0x811c9dc5)
对每个字节 b: h = (h XOR b) * 16777619 (0x01000193)，乘法按 32 位无符号整数截断
桶号 = h & (capacity - 1)
```

### Robin Hood 线性探测

- 每个槽位保存：键、完整 32 位哈希、值（JSON 字符串）、到理想桶的**环形距离** `dist = (slot - home + capacity) mod capacity`。
- 插入时，当新元素已走过的距离**严格大于**现有元素的距离就交换，被换出者继续探测；距离相同保持既有元素在前。
- 查询遇空槽停止；遇现有元素 `dist < 当前查询距离` 也可判定不存在（提前结束）。跨数组末端按环形距离计算，不把环形槽位当线性地址。
- 删除采用**后移**：把后续 `dist > 0` 的元素逐个前移一格并减距离，直到空槽或 `dist = 0` 的元素；移位可跨末端；不留墓碑。
- 更新已有键只替换值，不增加元素数、不产生第二份同名键。
- 容量为 2 的幂，初始至少 4；插入新键会使负载超过 3/4 时扩容为两倍，并按旧槽位顺序重新插入；达到 `maxCapacity` 后以错误码 `TABLE_FULL` 明确拒绝，不覆盖存量元素、不无限探测。

## HTTP API

统一返回 `{ ok: true, data }` 或 `{ ok: false, error: { code, message } }`。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/experiments` | 创建表 `{name?, capacity?, maxCapacity?}` |
| GET | `/experiments` | 列出实验 |
| GET | `/experiments/:id` | 实验参数 + 快照 + 不变量核验 |
| POST | `/experiments/:id/put` | 插入/更新 `{key, value}` |
| POST | `/experiments/:id/get` 或 GET `.../get?key=` | 查询 |
| POST | `/experiments/:id/delete` | 删除 `{key}` |
| GET | `/experiments/:id/slots` | 查看槽位布局 |
| GET | `/experiments/:id/ops` | 读取操作轨迹 |
| GET | `/experiments/:id/export` | 导出快照 |
| GET | `/experiments/:id/replay?to=N` | 历史回放（重放前 N 步，含每步槽位状态） |

错误码：`INVALID_PARAM`、`EXPERIMENT_NOT_FOUND`、`TABLE_FULL`、`NOT_FOUND`、`INTERNAL`。

每次写操作返回：操作前后元素数与容量、逐槽探测过程 `probes`、事件 `events`（区分实际发生的 `swap`/`shift`/`grow`/`insert`/`update`/`remove` 与未修改数据的 `noop`）、`changed` 标记。

## CLI

```powershell
npm run cli -- serve --port 8080     # 启动 API（省略 --port 则自动选空闲端口）
npm run cli -- create demo 4 64      # 创建实验
npm run cli -- put 1 key1 "{\"a\":1}"
npm run cli -- get 1 key1
npm run cli -- del 1 key1
npm run cli -- slots 1
npm run cli -- ops 1
npm run cli -- export 1
npm run cli -- replay 1 5
```

## 持久化与回放

SQLite 保存三张表：`experiments`（参数）、`operations`（操作序列与轨迹 JSON）、`snapshots`（最新槽位布局）。重启后查询结果与槽位布局完全恢复；`replay` 从初始参数逐步重放历史操作，返回每步之后的槽位状态。

## 测试

`npm test` 覆盖：FNV-1a 已知向量、严格距离比较触发交换、无效查询提前退出（空槽与距离规则）、跨末端冲突链、链首/链中删除、重复删除、更新已有键、扩容后全部键可查、容量上限拒绝，以及 500 步短随机操作序列与普通字典对拍，并独立核验所有槽位距离、唯一键与元素计数。

## 说明与限制

- 哈希冲突**不会丢数据**：冲突通过探测与交换在槽位数组内解决。
- 本题**不承诺**抵抗恶意碰撞（FNV-1a 非加密哈希，可被构造最坏情况）或高并发性能；服务为单进程教学模型。
- 值以 JSON 存储，单个键的 UTF-8 长度限制为 1024 字节。
