export type PurchaseAssignmentDraft = {
  purchaserMemberId: string;
  reviewerMemberId: string;
  currentPurchaserMemberId: string;
  currentReviewerMemberId: string;
  reason: string;
  developmentOpenAccess: boolean;
};

export function purchaseAssignmentBlock(draft: PurchaseAssignmentDraft) {
  if (!draft.purchaserMemberId || !draft.reviewerMemberId) {
    return '请选择新的采购负责人和复审人';
  }
  if (!draft.developmentOpenAccess && draft.purchaserMemberId === draft.reviewerMemberId) {
    return '正式模式要求采购负责人和复审人为不同成员';
  }
  if (
    draft.purchaserMemberId === draft.currentPurchaserMemberId
    && draft.reviewerMemberId === draft.currentReviewerMemberId
  ) {
    return '新负责人和复审人与当前指派相同';
  }
  if (draft.reason.trim().length < 2) {
    return '请填写至少 2 个字的真实交接原因';
  }
  return null;
}
