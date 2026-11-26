import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import type { Plugin } from 'vite';

export function feishuProcurementSyncPlugin(token: string, orderSourceConfig?: string): Plugin {
  return {
    name: 'local-feishu-procurement-sync',
    apply: 'serve',
    configureServer(server) {
      const http = server.httpServer;
      if (!http) return;

      http.once('listening', () => {
        const address = http.address();
        if (!address || typeof address === 'string') return;
        const host = address.address === '::1' ? '[::1]' : address.address;
        if (host !== '127.0.0.1' && host !== '[::1]') {
          server.config.logger.warn('飞书采购同步仅随本机环回 ERP 服务启动。');
          return;
        }

        const child = spawn(process.execPath, [
          resolve(server.config.root, 'scripts/run-feishu-procurement-sync.mjs'),
          `http://${host}:${address.port}`,
        ], {
          cwd: server.config.root,
          env: { ...process.env, ERP_FEISHU_MODE: 'continuous', ERP_FEISHU_SYNC_WORKER_TOKEN: token,
            ...(orderSourceConfig ? { ERP_FEISHU_ORDERS_SOURCE_CONFIG: orderSourceConfig } : {}) },
          stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
          windowsHide: true,
        });
        child.on('error', () => server.config.logger.warn('无法启动本机飞书采购同步。'));
        child.on('exit', (code) => {
          if (http.listening && code !== 0) {
            server.config.logger.warn('本机飞书采购同步已退出。');
          }
        });
        http.once('close', () => {
          if (child.connected) child.disconnect();
        });
      });
    },
  };
}
