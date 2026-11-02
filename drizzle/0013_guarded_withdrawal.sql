DROP TRIGGER IF EXISTS `trg_purchase_requests_validate_transition`;
--> statement-breakpoint
CREATE TRIGGER `trg_purchase_requests_validate_transition`
BEFORE UPDATE OF status ON `purchase_requests`
FOR EACH ROW WHEN NOT (
	(OLD.status = 'draft' AND NEW.status IN ('pending_review', 'cancelled'))
	OR (OLD.status = 'pending_review' AND NEW.status IN ('approved', 'rejected'))
	OR (OLD.status = 'approved' AND NEW.status = 'cancelled')
)
BEGIN
	SELECT RAISE(ABORT, 'INVALID_PURCHASE_REQUEST_TRANSITION');
END;
