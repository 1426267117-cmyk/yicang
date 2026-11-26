import { execFile } from 'node:child_process';
import { timingSafeEqual } from 'node:crypto';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import type { Plugin } from 'vite';

const run = promisify(execFile);
const localPath = '/__local/feishu-sources';
const maxConcurrentReads = 6;
const loopbackHosts = new Set(['127.0.0.1', 'localhost', '[::1]']);
const loopbackAddresses = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

export function feishuLiveSourcesPlugin(token: string, configPath: string): Plugin {
  const expectedAuthorization = Buffer.from(`Bearer ${token}`);
  const inFlight = new Map<string, Promise<string>>();

  return {
    name: 'feishu-live-sources-local',
    apply: 'serve',
    enforce: 'pre',
    configureServer(server) {
      const script = resolve(server.config.root, 'scripts/feishu-live-preview.py');
      server.middlewares.use((request, response, next) => {
        let url: URL;
        try {
          url = new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`);
        } catch {
          next();
          return;
        }
        if (url.pathname !== localPath) return next();

        response.setHeader('Cache-Control', 'private, no-store');
        response.setHeader('Content-Type', 'application/json; charset=utf-8');
        response.setHeader('X-Content-Type-Options', 'nosniff');
        const reply = (status: number, message: unknown) => {
          if (response.destroyed || response.headersSent) return;
          response.statusCode = status;
          response.end(typeof message === 'string' ? message : JSON.stringify(message));
        };
        const supplied = Buffer.from(request.headers.authorization ?? '');
        if (!loopbackAddresses.has(request.socket.remoteAddress ?? '') || !loopbackHosts.has(url.hostname)
          || supplied.length !== expectedAuthorization.length || !timingSafeEqual(supplied, expectedAuthorization)) {
          reply(403, { ok: false, code: 'FEISHU_LOCAL_ACCESS_DENIED', message: '无法使用本地飞书数据通道。' });
          return;
        }
        if (request.method !== 'GET') {
          response.setHeader('Allow', 'GET');
          reply(405, { ok: false, code: 'METHOD_NOT_ALLOWED', message: '飞书数据通道仅支持读取。' });
          return;
        }

        const source = url.searchParams.get('source');
        const table = url.searchParams.get('table');
        const count = Array.from(url.searchParams).length;
        const listing = count === 0;
        if (!listing && (count !== 2 || !source || !table
          || !/^[a-z][a-z0-9-]{0,40}$/.test(source) || !/^[a-z0-9_-]{1,60}$/i.test(table))) {
          reply(400, { ok: false, code: 'FEISHU_SOURCE_QUERY_INVALID', message: '请选择已登记的飞书子表。' });
          return;
        }
        const key = listing ? '' : `${source}/${table}`;
        let pending = inFlight.get(key);
        if (!pending) {
          if (inFlight.size >= maxConcurrentReads) {
            reply(503, { ok: false, code: 'FEISHU_SOURCE_BUSY', message: '飞书数据读取较忙，请稍后重试。' });
            return;
          }
          const args = ['-B', script, '--config', configPath];
          if (source && table) args.push('--source', source, '--table', table);
          const env: NodeJS.ProcessEnv = { ...process.env, PYTHONIOENCODING: 'utf-8' };
          delete env.ERP_FEISHU_SYNC_WORKER_TOKEN;
          pending = run(process.platform === 'win32' ? 'python' : 'python3', args, {
            env, windowsHide: true, timeout: 50_000, maxBuffer: 512 * 1024,
          }).then(({ stdout }) => stdout).finally(() => inFlight.delete(key));
          inFlight.set(key, pending);
        }
        void pending.then((body) => {
          const result = JSON.parse(body) as { ok?: boolean };
          reply(result.ok === true ? 200 : 422, body);
        }).catch(() => reply(503, {
          ok: false, code: 'FEISHU_SOURCE_READ_FAILED', message: '飞书数据读取失败，请稍后重试。',
        }));
      });
    },
  };
}
