import * as http from "node:http";
import { Store } from "./store";
import { CapacityExceededError } from "./table";

class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body, null, 2);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(data);
}

function readBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new ApiError(400, "INVALID_JSON", "请求体不是合法 JSON"));
      }
    });
    req.on("error", reject);
  });
}

function requireTable(store: Store, id: number) {
  const table = store.loadTable(id);
  if (!table) throw new ApiError(404, "TABLE_NOT_FOUND", `表 ${id} 不存在`);
  return table;
}

function parseId(seg: string | undefined): number {
  const id = Number(seg);
  if (!Number.isInteger(id) || id <= 0) throw new ApiError(400, "INVALID_ID", "表 id 必须是正整数");
  return id;
}

export function createServer(store: Store): http.Server {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const parts = url.pathname.split("/").filter(Boolean);
      const method = req.method ?? "GET";

      if (method === "GET" && parts.length === 0) {
        return json(res, 200, {
          name: "robinhood-lab",
          endpoints: [
            "POST /tables {name?, initialCapacity?, maxCapacity?}",
            "GET /tables",
            "GET /tables/:id",
            "PUT /tables/:id/kv/:key {value}",
            "GET /tables/:id/kv/:key",
            "DELETE /tables/:id/kv/:key",
            "GET /tables/:id/slots",
            "GET /tables/:id/ops",
            "GET /tables/:id/export",
            "GET /tables/:id/replay?to=<seq>",
          ],
        });
      }

      if (parts[0] === "tables" && parts.length === 1 && method === "POST") {
        const body = await readBody(req);
        const name = typeof body.name === "string" && body.name ? body.name : `table-${Date.now()}`;
        const init = body.initialCapacity ?? 4;
        const max = body.maxCapacity ?? 1 << 20;
        try {
          const meta = store.createTable(name, init, max);
          return json(res, 201, meta);
        } catch (e: any) {
          throw new ApiError(400, "INVALID_CONFIG", e.message);
        }
      }

      if (parts[0] === "tables" && parts.length === 1 && method === "GET") {
        return json(res, 200, store.listTables());
      }

      if (parts[0] === "tables" && parts.length >= 2) {
        const id = parseId(parts[1]);

        if (parts.length === 2 && method === "GET") {
          const meta = store.getMeta(id);
          if (!meta) throw new ApiError(404, "TABLE_NOT_FOUND", `表 ${id} 不存在`);
          return json(res, 200, meta);
        }

        if (parts[2] === "slots" && method === "GET") {
          const table = requireTable(store, id);
          return json(res, 200, { capacity: table.capacity, size: table.size, slots: table.dumpSlots() });
        }

        if (parts[2] === "ops" && method === "GET") {
          if (!store.getMeta(id)) throw new ApiError(404, "TABLE_NOT_FOUND", `表 ${id} 不存在`);
          return json(res, 200, store.listOps(id));
        }

        if (parts[2] === "export" && method === "GET") {
          const snap = store.exportSnapshot(id);
          if (!snap) throw new ApiError(404, "TABLE_NOT_FOUND", `表 ${id} 不存在`);
          return json(res, 200, snap);
        }

        if (parts[2] === "replay" && method === "GET") {
          const to = url.searchParams.get("to");
          const toSeq = to === null ? undefined : Number(to);
          if (toSeq !== undefined && (!Number.isInteger(toSeq) || toSeq < 0)) {
            throw new ApiError(400, "INVALID_SEQ", "to 必须是非负整数");
          }
          try {
            return json(res, 200, store.replay(id, toSeq));
          } catch {
            throw new ApiError(404, "TABLE_NOT_FOUND", `表 ${id} 不存在`);
          }
        }

        if (parts[2] === "kv" && parts.length === 4) {
          const key = decodeURIComponent(parts[3]);
          const table = requireTable(store, id);

          if (method === "PUT") {
            const body = await readBody(req);
            if (!("value" in body)) throw new ApiError(400, "MISSING_VALUE", "请求体必须包含 value 字段");
            try {
              const trace = table.set(key, body.value);
              const seq = store.recordOp(id, "set", key, body.value, trace, table);
              return json(res, 200, { seq, trace });
            } catch (e) {
              if (e instanceof CapacityExceededError) {
                throw new ApiError(409, "CAPACITY_EXCEEDED", e.message);
              }
              throw e;
            }
          }

          if (method === "GET") {
            const { trace, value, found } = table.get(key);
            const seq = store.recordOp(id, "get", key, undefined, trace, table);
            if (!found) {
              return json(res, 404, { error: { code: "KEY_NOT_FOUND", message: "键不存在" }, seq, trace });
            }
            return json(res, 200, { seq, value, trace });
          }

          if (method === "DELETE") {
            const { trace, removed } = table.delete(key);
            const seq = store.recordOp(id, "delete", key, undefined, trace, table);
            if (!removed) {
              return json(res, 404, { error: { code: "KEY_NOT_FOUND", message: "键不存在，未发生修改" }, seq, trace });
            }
            return json(res, 200, { seq, trace });
          }
        }
      }

      throw new ApiError(404, "NOT_FOUND", "路由不存在");
    } catch (e: any) {
      if (e instanceof ApiError) {
        return json(res, e.status, { error: { code: e.code, message: e.message } });
      }
      return json(res, 500, { error: { code: "INTERNAL", message: String(e?.message ?? e) } });
    }
  });
}

export function startServer(port?: number): Promise<{ server: http.Server; port: number }> {
  const store = new Store();
  const server = createServer(store);
  return new Promise((resolve) => {
    server.listen(port ?? 0, () => {
      const addr = server.address() as any;
      resolve({ server, port: addr.port });
    });
  });
}

if (require.main === module) {
  const argPort = process.argv.find((a) => a.startsWith("--port="));
  const envPort = process.env.PORT;
  const port = argPort ? Number(argPort.split("=")[1]) : envPort ? Number(envPort) : undefined;
  if (port !== undefined && (!Number.isInteger(port) || port < 0 || port > 65535)) {
    console.error("端口必须是 0-65535 的整数");
    process.exit(1);
  }
  startServer(port).then(({ port }) => {
    console.log(`robinhood-lab API 已启动: http://localhost:${port}`);
  });
}
