import { describe, expect, it } from 'vitest';

import { POST } from '../app/api/purchase/requests/route';
import {
  DIRECT_PURCHASE_REQUEST_DISABLED_CODE,
  DIRECT_PURCHASE_REQUEST_DISABLED_MESSAGE,
} from '../lib/procurement-ui';

describe('订单需求旧直转入口', () => {
  it('无论请求内容如何都失败关闭，并指向采购建议入口', async () => {
    const response = await POST();
    const body = await response.json() as Record<string, unknown>;

    expect(response.status).toBe(410);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(body).toEqual({
      ok: false,
      code: DIRECT_PURCHASE_REQUEST_DISABLED_CODE,
      message: DIRECT_PURCHASE_REQUEST_DISABLED_MESSAGE,
      replacementEndpoint: '/api/purchase/planning/requests',
    });
  });
});
