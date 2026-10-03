import http from 'node:http';
import { Store, ExperimentError } from './db';
import { TableFullError } from './table';

function send(res: http.ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(data);
}

function ok(res: http.ServerResponse, data: unknown): void {
  send(res, 200, { ok: true, data });
}

function fail(res: http.ServerResponse, status: number, code: string, message: string): void {
  send(res, status, { ok: false, error: { code, message } });
}

async function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new ExperimentError('INVALID_PARAM', '请求体不是合法 JSON');
  }
}

export function createServer(store: Store): http.Server {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const parts = url.pathname.split('/').filter(Boolean);
      const method = req.method ?? 'GET';

      if (method === 'GET' && url.pathname === '/health') {
        return ok(res, { status: 'up' });
      }

      if (parts[0] === 'experiments') {
        if (parts.length === 1 && method === 'POST') {
          const b = await readBody(req);
          return ok(res, store.createExperiment(
            String(b.name ?? 'experiment'),
            b.capacity === undefined ? undefined : Number(b.capacity),
            b.maxCapacity === undefined ? undefined : Number(b.maxCapacity)
          ));
        }
        if (parts.length === 1 && method === 'GET') {
          return ok(res, store.listExperiments());
        }
        const id = Number(parts[1]);
        if (!Number.isInteger(id)) return fail(res, 400, 'INVALID_PARAM', '实验 id 必须是整数');
        const sub = parts[2];

        if (parts.length === 2 && method === 'GET') return ok(res, store.exportSnapshot(id));
        if (sub === 'put' && method === 'POST') {
          const b = await readBody(req);
          return ok(res, store.put(id, b.key as string, b.value));
        }
        if (sub === 'delete' && method === 'POST') {
          const b = await readBody(req);
          return ok(res, store.remove(id, b.key as string));
        }
        if (sub === 'get' && method === 'POST') {
          const b = await readBody(req);
          return ok(res, store.get(id, b.key as string));
        }
        if (sub === 'get' && method === 'GET') {
          return ok(res, store.get(id, url.searchParams.get('key') ?? ''));
        }
        if (sub === 'slots' && method === 'GET') return ok(res, store.slots(id));
        if (sub === 'ops' && method === 'GET') return ok(res, store.operations(id));
        if (sub === 'export' && method === 'GET') return ok(res, store.exportSnapshot(id));
        if (sub === 'replay' && method === 'GET') {
          const to = url.searchParams.get('to');
          return ok(res, store.replay(id, to === null ? undefined : Number(to)));
        }
      }
      return fail(res, 404, 'NOT_FOUND', `未知路由 ${method} ${url.pathname}`);
    } catch (e) {
      if (e instanceof TableFullError) return fail(res, 409, e.code, e.message);
      if (e instanceof ExperimentError) return fail(res, 400, e.code, e.message);
      return fail(res, 500, 'INTERNAL', (e as Error).message);
    }
  });
}

// 默认端口 0：由操作系统分配空闲端口
export function startServer(store: Store, port = 0): Promise<{ server: http.Server; port: number }> {
  const server = createServer(store);
  return new Promise((resolve) => {
    server.listen(port, () => {
      const addr = server.address();
      const p = typeof addr === 'object' && addr ? addr.port : port;
      resolve({ server, port: p });
    });
  });
}
