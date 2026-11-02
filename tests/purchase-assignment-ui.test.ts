import { describe, expect, it } from 'vitest';

import { purchaseAssignmentBlock } from '../lib/purchase-assignment-ui';

const validDraft = {
  purchaserMemberId: 'buyer-b',
  reviewerMemberId: 'reviewer-b',
  currentPurchaserMemberId: 'buyer-a',
  currentReviewerMemberId: 'reviewer-a',
  reason: '负责人休假交接',
  developmentOpenAccess: false,
};

describe('采购重新指派表单规则', () => {
  it('正式模式阻止同人负责和复审', () => {
    expect(purchaseAssignmentBlock({
      ...validDraft,
      purchaserMemberId: 'admin-b',
      reviewerMemberId: 'admin-b',
    })).toContain('不同成员');
  });

  it('开发开放模式允许同人但仍要求真实变更和原因', () => {
    expect(purchaseAssignmentBlock({
      ...validDraft,
      purchaserMemberId: 'admin-b',
      reviewerMemberId: 'admin-b',
      developmentOpenAccess: true,
    })).toBeNull();
    expect(purchaseAssignmentBlock({
      ...validDraft,
      purchaserMemberId: validDraft.currentPurchaserMemberId,
      reviewerMemberId: validDraft.currentReviewerMemberId,
    })).toContain('当前指派相同');
    expect(purchaseAssignmentBlock({ ...validDraft, reason: ' ' })).toContain('至少 2 个字');
  });
});
