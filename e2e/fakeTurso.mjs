/**
 * A stand-in for Turso, for the end-to-end tests.
 *
 * The app talks to Turso with @libsql/client's web build, which speaks Hrana-over-HTTP (JSON). This
 * serves just enough of that protocol, backed by a real in-memory SQLite, so the tests exercise the
 * app's actual SQL and migrations and never touch the real database or need a network or a token.
 * Run by Playwright's `webServer`; the data lives only as long as the process.
 */
import { createServer } from 'node:http';
import { createClient } from '@libsql/client';

const PORT = Number(process.env.FAKE_TURSO_PORT ?? 8787);
const db = createClient({ url: ':memory:' });

const toArg = (v) => {
  switch (v.type) {
    case 'null':
      return null;
    case 'integer':
      return BigInt(v.value);
    case 'float':
      return Number(v.value);
    case 'text':
      return String(v.value);
    case 'blob':
      return Buffer.from(v.base64, 'base64');
    default:
      throw new Error(`unknown value type ${v.type}`);
  }
};

const toValue = (v) => {
  if (v === null || v === undefined) return { type: 'null' };
  if (typeof v === 'bigint') return { type: 'integer', value: v.toString() };
  if (typeof v === 'number')
    return Number.isInteger(v) ? { type: 'integer', value: String(v) } : { type: 'float', value: v };
  if (typeof v === 'string') return { type: 'text', value: v };
  if (v instanceof ArrayBuffer) return { type: 'blob', base64: Buffer.from(v).toString('base64') };
  return { type: 'text', value: String(v) };
};

const sqls = new Map();

async function execute(stmt) {
  const sql = stmt.sql ?? sqls.get(stmt.sql_id);
  let args = (stmt.args ?? []).map(toArg);
  if (stmt.named_args?.length)
    args = Object.fromEntries(stmt.named_args.map((a) => [a.name.replace(/^[:@$]/, ''), toArg(a.value)]));
  const rs = await db.execute({ sql, args });
  return {
    cols: rs.columns.map((name) => ({ name, decltype: null })),
    rows: rs.rows.map((row) => rs.columns.map((_, i) => toValue(row[i]))),
    affected_row_count: rs.rowsAffected,
    last_insert_rowid: rs.lastInsertRowid === undefined ? null : rs.lastInsertRowid.toString(),
    replication_index: null,
    rows_read: 0,
    rows_written: 0,
    query_duration_ms: 0,
  };
}

const holds = (cond, ok, err) => {
  if (!cond) return true;
  switch (cond.type) {
    case 'ok':
      return ok[cond.step] != null;
    case 'error':
      return err[cond.step] != null;
    case 'not':
      return !holds(cond.cond, ok, err);
    case 'and':
      return cond.conds.every((c) => holds(c, ok, err));
    case 'or':
      return cond.conds.some((c) => holds(c, ok, err));
    default:
      return true;
  }
};

async function handle(req) {
  switch (req.type) {
    case 'execute':
      return { type: 'execute', result: await execute(req.stmt) };
    case 'batch': {
      const ok = [],
        err = [];
      for (const [i, step] of req.batch.steps.entries()) {
        ok[i] = null;
        err[i] = null;
        if (!holds(step.condition, ok, err)) continue;
        try {
          ok[i] = await execute(step.stmt);
        } catch (e) {
          err[i] = { message: e.message, code: e.code ?? 'ERROR' };
        }
      }
      return { type: 'batch', result: { step_results: ok, step_errors: err } };
    }
    case 'sequence': {
      await db.executeMultiple(req.sql ?? sqls.get(req.sql_id));
      return { type: 'sequence' };
    }
    case 'store_sql':
      sqls.set(req.sql_id, req.sql);
      return { type: 'store_sql' };
    case 'close_sql':
      sqls.delete(req.sql_id);
      return { type: 'close_sql' };
    case 'get_autocommit':
      return { type: 'get_autocommit', is_autocommit: true };
    case 'close':
      return { type: 'close' };
    default:
      throw new Error(`unsupported request ${req.type}`);
  }
}

const cors = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
};

createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors).end();
    return;
  }
  if (req.method === 'GET' && req.url === '/v2') {
    res.writeHead(200, cors).end('ok');
    return;
  }
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, cors).end('ok');
    return;
  }
  if (req.method === 'POST' && req.url === '/v2/pipeline') {
    let body = '';
    for await (const chunk of req) body += chunk;
    const results = [];
    for (const r of JSON.parse(body).requests) {
      try {
        results.push({ type: 'ok', response: await handle(r) });
      } catch (e) {
        results.push({ type: 'error', error: { message: e.message, code: e.code ?? 'ERROR' } });
      }
    }
    res.writeHead(200, { ...cors, 'content-type': 'application/json' });
    res.end(JSON.stringify({ baton: null, base_url: null, results }));
    return;
  }
  res.writeHead(404, cors).end(); // includes the /v3 probes: the client falls back to /v2
}).listen(PORT, () => console.log(`fake turso on http://localhost:${PORT}`));
