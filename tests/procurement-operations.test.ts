import { describe, expect, it } from 'vitest';
import type { MukuFreshnessReport } from '../lib/muku-freshness-service';
import { buildProcurementOperationsStatus } from '../lib/procurement-operations';

const internalToken = 'test-internal-job-token-32-characters-long';
const mukuKey = 'test-muku-read-only-key-32-characters-long';

describe('采购数据自动化运维状态', () => {
  it('区分受保护入口与实际外部调度，并且不把页面刷新当成采集', () => {
    const status = buildProcurementOperationsStatus({
      freshness: freshMukuReport(),
      orderSources: [shopifySource()],
      shopifyAuthorizedStoreKeys: ['bizfurniz'],
      orderSyncMaxAgeMinutes: 30,
      runtimeEnv: {
        ERP_INTERNAL_JOB_TOKEN: internalToken,
        MUKU_DASHBOARD_API_KEY: mukuKey,
      },
    });

    expect(status.browserRefresh).toEqual(expect.objectContaining({
      guaranteedCollection: false,
      shopifySyncTriggered: false,
      mukuDueRefreshMayTrigger: true,
    }));
    expect(status.internalJobAuthConfigured).toBe(true);
    expect(status.muku).toEqual(expect.objectContaining({
      endpointReady: true,
      externalScheduleConfigured: false,
      automationReady: false,
      freshUntil: '2026-11-02T12:25:00.000Z',
      nextRefreshDueAt: '2026-11-02T12:08:00.000Z',
    }));
    expect(status.shopify).toEqual(expect.objectContaining({
      endpointReady: true,
      externalScheduleConfigured: false,
      automationReady: false,
      lastSuccessAt: '2026-11-02T11:50:00.000Z',
      nextExpiryAt: '2026-11-02T12:20:00.000Z',
    }));
    expect(status.automationReady).toBe(false);
    expect(status.muku.configurationBlockers.join('；')).toContain('尚未确认外部调度器');
    expect(status.shopify.configurationBlockers.join('；')).toContain('尚未确认外部调度器');
  });

  it('只有安全密钥、数据源和两个外部调度均明确配置时才标记闭环', () => {
    const status = buildProcurementOperationsStatus({
      freshness: freshMukuReport(),
      orderSources: [shopifySource()],
      shopifyAuthorizedStoreKeys: ['bizfurniz'],
      orderSyncMaxAgeMinutes: 30,
      runtimeEnv: {
        ERP_INTERNAL_JOB_TOKEN: internalToken,
        MUKU_DASHBOARD_API_KEY: mukuKey,
        ERP_MUKU_EXTERNAL_SCHEDULE_CONFIGURED: 'true',
        ERP_SHOPIFY_RECONCILE_SCHEDULE_CONFIGURED: true,
      },
    });

    expect(status.automationReady).toBe(true);
    expect(status.muku).toEqual(expect.objectContaining({
      endpointReady: true,
      externalScheduleConfigured: true,
      automationReady: true,
    }));
    expect(status.shopify).toEqual(expect.objectContaining({
      endpointReady: true,
      externalScheduleConfigured: true,
      automationReady: true,
    }));
    expect(status.muku.configurationBlockers).toEqual([]);
    expect(status.shopify.configurationBlockers).toEqual([]);
  });

  it('Sites MCP 托管任务使用允许邮箱即可闭环，不要求内部任务密钥或旧调度开关', () => {
    const status = buildProcurementOperationsStatus({
      freshness: freshMukuReport(),
      orderSources: [shopifySource()],
      shopifyAuthorizedStoreKeys: ['bizfurniz'],
      orderSyncMaxAgeMinutes: 75,
      runtimeEnv: {
        MUKU_DASHBOARD_API_KEY: mukuKey,
        ERP_SITES_PROCUREMENT_SCHEDULE_CONFIGURED: 'true',
        ERP_AUTOMATION_ALLOWED_EMAILS: 'owner@example.com',
      },
    });

    expect(status).toEqual(expect.objectContaining({
      internalJobAuthConfigured: false,
      sitesMcpScheduleConfigured: true,
      automationAllowedEmailsConfigured: true,
      schedulerMode: 'sites_mcp',
      automationReady: true,
    }));
    expect(status.browserRefresh.note).toContain('Sites 托管任务');
    expect(status.muku).toEqual(expect.objectContaining({
      endpointReady: false,
      externalScheduleConfigured: true,
      automationReady: true,
    }));
    expect(status.shopify).toEqual(expect.objectContaining({
      endpointReady: false,
      externalScheduleConfigured: true,
      automationReady: true,
      maxAgeMinutes: 75,
    }));
    expect(status.muku.configurationBlockers).toEqual([]);
    expect(status.shopify.configurationBlockers).toEqual([]);
  });

  it('Sites MCP 托管任务缺少允许邮箱时失败关闭，但不误报内部任务缺失', () => {
    const status = buildProcurementOperationsStatus({
      freshness: freshMukuReport(),
      orderSources: [shopifySource()],
      shopifyAuthorizedStoreKeys: ['bizfurniz'],
      orderSyncMaxAgeMinutes: 75,
      runtimeEnv: {
        MUKU_DASHBOARD_API_KEY: mukuKey,
        ERP_SITES_PROCUREMENT_SCHEDULE_CONFIGURED: true,
      },
    });

    expect(status.automationReady).toBe(false);
    expect(status.automationAllowedEmailsConfigured).toBe(false);
    expect(status.muku.configurationBlockers.join('；')).toContain('自动化允许邮箱');
    expect(status.shopify.configurationBlockers.join('；')).toContain('自动化允许邮箱');
    expect(status.muku.configurationBlockers.join('；')).not.toContain('内部任务密钥');
    expect(status.shopify.configurationBlockers.join('；')).not.toContain('内部任务密钥');
    expect(status.muku.configurationBlockers.join('；')).not.toContain('外部调度器');
    expect(status.shopify.configurationBlockers.join('；')).not.toContain('外部调度器');
  });

  it('环境 ADMIN_ACCESS_TOKEN 可使 Shopify 对账入口就绪但不伪造已同步数据源', () => {
    const status = buildProcurementOperationsStatus({
      freshness: freshMukuReport(),
      orderSources: [],
      orderSyncMaxAgeMinutes: 30,
      runtimeEnv: {
        ERP_INTERNAL_JOB_TOKEN: internalToken,
        SHOPIFY_BIZFURNIZ_SHOP_DOMAIN: 'fixture-bizfurniz-canonical.myshopify.com',
        SHOPIFY_BIZFURNIZ_ADMIN_ACCESS_TOKEN: 'test-admin-access-token',
      },
    });

    expect(status.shopify).toEqual(expect.objectContaining({
      sourceConfigured: true,
      endpointReady: true,
      externalScheduleConfigured: false,
      automationReady: false,
      lastSuccessAt: null,
      nextExpiryAt: null,
      stores: [],
    }));
    expect(status.shopify.configurationBlockers.join('；')).not.toContain('OAuth 授权');
  });

  it('只有坏域名的环境 Token 时不误报入口就绪', () => {
    const status = buildProcurementOperationsStatus({
      freshness: freshMukuReport(),
      orderSources: [],
      orderSyncMaxAgeMinutes: 30,
      runtimeEnv: {
        ERP_INTERNAL_JOB_TOKEN: internalToken,
        SHOPIFY_ZIMASYA_ADMIN_ACCESS_TOKEN: 'test-bad-store-token',
        SHOPIFY_ZIMASYA_SHOP_DOMAIN: 'not-a-shopify-domain.example',
      },
    });

    expect(status.shopify).toEqual(expect.objectContaining({
      sourceConfigured: false,
      endpointReady: false,
      automationReady: false,
    }));
    expect(status.shopify.configurationBlockers.join('；')).toContain('尚未发现 Shopify OAuth 授权');
  });

  it('坏域名环境店不影响其他有效环境店的入口就绪判断', () => {
    const status = buildProcurementOperationsStatus({
      freshness: freshMukuReport(),
      orderSources: [],
      orderSyncMaxAgeMinutes: 30,
      runtimeEnv: {
        ERP_INTERNAL_JOB_TOKEN: internalToken,
        SHOPIFY_ZIMASYA_ADMIN_ACCESS_TOKEN: 'test-bad-store-token',
        SHOPIFY_ZIMASYA_SHOP_DOMAIN: 'not-a-shopify-domain.example',
        SHOPIFY_BIZFURNIZ_SHOP_DOMAIN: 'fixture-bizfurniz-canonical.myshopify.com',
        SHOPIFY_BIZFURNIZ_ADMIN_ACCESS_TOKEN: 'test-good-store-token',
      },
    });

    expect(status.shopify).toEqual(expect.objectContaining({
      sourceConfigured: true,
      endpointReady: true,
      automationReady: false,
    }));
    expect(status.shopify.configurationBlockers.join('；')).not.toContain('OAuth 授权');
  });

  it('好店与坏店并存时入口可用但自动化闭环必须阻断', () => {
    const status = buildProcurementOperationsStatus({
      freshness: freshMukuReport(),
      orderSources: [shopifySource()],
      orderSyncMaxAgeMinutes: 30,
      runtimeEnv: {
        ERP_INTERNAL_JOB_TOKEN: internalToken,
        MUKU_DASHBOARD_API_KEY: mukuKey,
        ERP_MUKU_EXTERNAL_SCHEDULE_CONFIGURED: true,
        ERP_SHOPIFY_RECONCILE_SCHEDULE_CONFIGURED: true,
        SHOPIFY_ZIMASYA_ADMIN_ACCESS_TOKEN: 'test-bad-store-token',
        SHOPIFY_ZIMASYA_SHOP_DOMAIN: 'not-a-shopify-domain.example',
        SHOPIFY_BIZFURNIZ_SHOP_DOMAIN: 'fixture-bizfurniz-canonical.myshopify.com',
        SHOPIFY_BIZFURNIZ_ADMIN_ACCESS_TOKEN: 'test-good-store-token',
      },
    });

    expect(status.shopify).toEqual(expect.objectContaining({
      sourceConfigured: true,
      endpointReady: true,
      externalScheduleConfigured: true,
      automationReady: false,
      invalidEnvironmentStoreCount: 1,
      invalidEnvironmentStoreKeys: ['zimasya'],
    }));
    expect(status.shopify.configurationBlockers.join('；')).toContain('环境店凭证配置无效');
    expect(status.automationReady).toBe(false);
  });

  it('尚未生成平台店铺时也能从 D1 OAuth 授权口径判断入口就绪', () => {
    const status = buildProcurementOperationsStatus({
      freshness: freshMukuReport(),
      orderSources: [],
      shopifyAuthorizedStoreKeys: ['bizfurniz'],
      orderSyncMaxAgeMinutes: 30,
      runtimeEnv: { ERP_INTERNAL_JOB_TOKEN: internalToken },
    });

    expect(status.shopify.sourceConfigured).toBe(true);
    expect(status.shopify.endpointReady).toBe(true);
  });

  it('历史官方店铺仍展示新鲜度，但凭证已移除时不误报自动化就绪', () => {
    const status = buildProcurementOperationsStatus({
      freshness: freshMukuReport(),
      orderSources: [shopifySource()],
      shopifyAuthorizedStoreKeys: [],
      orderSyncMaxAgeMinutes: 30,
      runtimeEnv: {
        ERP_INTERNAL_JOB_TOKEN: internalToken,
        ERP_SHOPIFY_RECONCILE_SCHEDULE_CONFIGURED: true,
      },
    });

    expect(status.shopify.stores).toHaveLength(1);
    expect(status.shopify).toEqual(expect.objectContaining({
      sourceConfigured: false,
      endpointReady: false,
      automationReady: false,
    }));
    expect(status.shopify.configurationBlockers.join('；')).toContain('尚未发现 Shopify OAuth 授权');
  });

  it('缺少密钥、官方店铺或有效时间时保持未知并给出阻断原因', () => {
    const freshness = freshMukuReport();
    freshness.datasets[0] = {
      ...freshness.datasets[0],
      fresh: false,
      generatedAt: 'invalid',
      reasons: [{
        code: 'SOURCE_TIME_INVALID',
        dataset: 'inventory',
        message: 'MUKU inventory 上游生成时间无效',
      }],
    };
    freshness.readyForProcurement = false;
    freshness.blockingReasons = freshness.datasets[0].reasons;

    const status = buildProcurementOperationsStatus({
      freshness,
      orderSources: [{ ...shopifySource(), official: false, reasons: ['local_qa_excluded'] }],
      orderSyncMaxAgeMinutes: 30,
      runtimeEnv: {},
    });

    expect(status.internalJobAuthConfigured).toBe(false);
    expect(status.muku.endpointReady).toBe(false);
    expect(status.browserRefresh.mukuDueRefreshMayTrigger).toBe(false);
    expect(status.muku.freshUntil).toBeNull();
    expect(status.muku.dataBlockers).toContain('MUKU inventory 上游生成时间无效');
    expect(status.shopify.endpointReady).toBe(false);
    expect(status.shopify.lastSuccessAt).toBeNull();
    expect(status.shopify.nextExpiryAt).toBeNull();
    expect(status.shopify.configurationBlockers.join('；')).toContain('尚未发现 Shopify OAuth 授权');
  });
});

function freshMukuReport(): MukuFreshnessReport {
  return {
    checkedAt: '2026-11-02T12:00:00.000Z',
    status: 'fresh',
    readyForProcurement: true,
    maxAgeMinutes: 30,
    minRefreshIntervalMinutes: 10,
    datasets: [{
      dataset: 'inventory',
      requiredForProcurement: true,
      fresh: true,
      stateStatus: 'succeeded',
      activeSnapshotId: 'snapshot-1',
      generatedAt: '2026-11-02T11:55:00.000Z',
      lastSuccessAt: '2026-11-02T11:58:00.000Z',
      sourceAgeMinutes: 5,
      erpSyncAgeMinutes: 2,
      recordCount: 2,
      lastErrorCode: null,
      lastErrorAt: null,
      reasons: [],
    }],
    blockingReasons: [],
    needsRefresh: false,
    refreshDue: false,
    refreshInProgress: false,
    lastAttemptAt: '2026-11-02T11:58:00.000Z',
    nextRefreshAt: '2026-11-02T12:08:00.000Z',
  };
}

function shopifySource() {
  return {
    storeId: 'store-bizfurniz',
    platform: 'shopify',
    storeKey: 'bizfurniz',
    storeName: 'BizFurniz',
    official: true,
    ready: true,
    lastSuccessAt: '2026-11-02T11:50:00.000Z',
    ageMinutes: 10,
    syncStatus: 'succeeded',
    lastErrorCode: null,
    reasons: [],
  };
}
