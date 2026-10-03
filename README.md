# robinhood-lab

一个可解释 Robin Hood 哈希表实验后端：开放寻址、线性探测、后移删除，逐步展示冲突、元素交换、查询提前结束与删除后移动。只做 API 与 CLI，纯 Windows 本地运行，不依赖 Docker / WSL / 外部服务。

这是一个数据结构教学/实验模型，不是通用数据库、分片系统或性能基准平台。

## 环境要求

- Node.js >= 22.5（使用内置 `node:sqlite`，无需原生编译）
- 仅一个开发依赖：TypeScript

## 快速开始

```powershell
npm install
npm run build     # 编译 TypeScript 到 dist/
npm test          # 构建并运行全部测试
npm start         # 启动 API 服务（默认自动选择空闲端口）
npm start -- --port=8080   # 指定端口（也可用环境变量 PORT）
npm run demo      # 演示：冲突链 -> 删除后移 -> 重启读取快照
```

数据保存在项目内 `data/robinhood.db`（演示用 `data/demo.db`），重启后查询结果与槽位布局均可恢复。

## 核心规则

- **哈希**：FNV-1a 32 位，对键的 UTF-8 字节计算。初值 `0x811c9dc5`，每字节先异或再乘 `0x01000193`，乘法按 32 位无符号整数截断（`Math.imul`）。桶号 = `hash & (capacity - 1)`，容量恒为 2 的幂。同一输入必然复现同一结果。
- **槽位**：保存键、完整哈希、JSON 值、到理想桶的**环形距离** `dist = (slot - bucket + capacity) % capacity`，跨末端环绕时距离计算依然正确。
- **插入（Robin Hood）**：当新元素已走过的距离**严格大于**槽内既有元素的距离时交换二者，被换出者继续探测；距离相等保持既有元素在前。
- **查询**：遇空槽停止；遇既有元素 `dist` 小于当前查询距离即可判定不存在（提前退出）。
- **删除（后移，无墓碑）**：将后续 `dist > 0` 的元素逐个前移一格并减一距离，直到空槽或 `dist = 0` 的元素；移位可跨末端。
- **更新**：已有键只替换值，不增加元素数、不产生第二份同名键。
- **扩容**：插入新键会使负载超过 3/4 时扩容为两倍，按旧槽位顺序重新插入；达到 `maxCapacity` 后返回 `CAPACITY_EXCEEDED` 明确拒绝，不覆盖存量、不无限探测。初始容量至少为 4。

## HTTP API

所有错误返回 `{"error": {"code": "...", "message": "..."}}`。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/tables` | 创建表 `{name?, initialCapacity?, maxCapacity?}` |
| GET | `/tables` | 列出所有表 |
| GET | `/tables/:id` | 表元信息 |
| PUT | `/tables/:id/kv/:key` | 插入/更新，body `{"value": ...}`，返回操作轨迹 |
| GET | `/tables/:id/kv/:key` | 查询，返回值与探测轨迹 |
| DELETE | `/tables/:id/kv/:key` | 删除，返回后移轨迹 |
| GET | `/tables/:id/slots` | 查看槽位布局 |
| GET | `/tables/:id/ops` | 读取完整操作轨迹 |
| GET | `/tables/:id/export` | 导出快照（元信息 + 槽位 + 操作序列） |
| GET | `/tables/:id/replay?to=<seq>` | 从空表重放操作，逐步返回槽位布局 |

轨迹事件类型：`probe`（探测）、`swap`（实际发生的交换）、`shift`（后移）、`resize`（扩容）、`insert` / `update` / `hit` / `miss` / `delete` / `noop`（未发生数据修改）。每条轨迹含操作前后元素数与探测过程。

错误码：`INVALID_CONFIG`、`INVALID_ID`、`INVALID_JSON`、`MISSING_VALUE`、`INVALID_SEQ`、`TABLE_NOT_FOUND`、`KEY_NOT_FOUND`、`CAPACITY_EXCEEDED`、`NOT_FOUND`、`INTERNAL`。

## CLI

```powershell
npm run cli -- create mytable 8 1024
npm run cli -- put 1 mykey '{"a":1}'
npm run cli -- get 1 mykey
npm run cli -- del 1 mykey
npm run cli -- slots 1
npm run cli -- ops 1
npm run cli -- export 1
npm run cli -- replay 1
npm run cli -- list
```

## 测试

`npm test` 覆盖：FNV-1a 已知向量、同桶冲突键、严格距离比较触发交换、距离相等不交换、无效查询提前退出、跨末端冲突链、链首/链中删除、重复删除、更新已有键、扩容后全部键可查、容量上限拒绝，以及 500 步随机操作与普通字典比对，并独立核验所有槽位距离、唯一键与元素计数。

## 说明与限制

- 哈希冲突**不会**丢数据：冲突键按 Robin Hood 规则在槽位数组中重新安置，删除后后移保持查询正确性。
- 本题**不承诺**抵抗恶意碰撞（FNV-1a 非加密哈希，攻击者可构造大量同桶键使探测退化），也**不承诺**高并发性能（单进程、每操作整表快照持久化，面向小规模实验）。
- 键值存储核心为自实现槽位数组；SQLite 仅用于保存实验参数、操作序列与快照，不参与查找算法。
