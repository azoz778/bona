import { createHash } from 'node:crypto';

// Hashes stay inside the private lead database, never in event payloads or logs.
export function enquiryFingerprint(q) {
  const fields = ['form', 'name', 'phone', 'interest', 'type', 'budget', 'location', 'message', 'listing_id', 'page', 'locale'];
  return createHash('sha256').update(JSON.stringify(fields.map(k => q[k] ?? null))).digest('hex');
}
export function previousEnquiry(db, q) {
  const receipt = db.db.prepare('SELECT payload_hash, lead_id FROM enquiry_receipts WHERE event_id = ?').get(q.event_id);
  if (!receipt) return null;
  if (receipt.payload_hash !== enquiryFingerprint(q)) throw Object.assign(new Error('Request changed. Please submit a new enquiry.'), { code: 'ENQUIRY_CONFLICT' });
  return { lead_id: receipt.lead_id };
}
export function saveEnquiryReceipt(db, q, leadId, now) {
  db.db.prepare('INSERT INTO enquiry_receipts(event_id,payload_hash,lead_id,created) VALUES(?,?,?,?)')
    .run(q.event_id, enquiryFingerprint(q), leadId, now);
}

/**
 * At start-up, before anything is sent: a receipt still `pending` lost its owner note with the
 * last process (it may or may not have gone), so it becomes `uncertain` — unless ITS note (the
 * ledger row whose meta names this receipt's event) is still queued in the owner-notes ledger
 * (DESIGN §7.1, critic round 2 #17b: Sending off or the pacing held it); that one goes later and
 * moves its receipt on itself. Matched by event, not by lead: another form of the same lead has
 * no note of its own and is recovered like any other.
 */
export function recoverPendingNotifications(db) {
 return db.transaction(() => ({
  enquiries: db.db.prepare(`UPDATE enquiry_receipts SET notify_status='uncertain' WHERE notify_status='pending'
    AND NOT EXISTS (SELECT 1 FROM owner_notes n WHERE n.kind='new_client' AND n.status='queued' AND n.lead_id=enquiry_receipts.lead_id
      AND (CASE WHEN json_valid(n.meta) THEN json_extract(n.meta,'$.ev') END)=enquiry_receipts.event_id)`).run().changes,
  handoffs: db.db.prepare("UPDATE lead_tasks SET telegram_status='uncertain' WHERE telegram_status='pending'").run().changes,
 }));
}

export function enquiryNotifications(db, leadId) {
 return db.db.prepare('SELECT event_id,created,notify_status FROM enquiry_receipts WHERE lead_id=? ORDER BY created DESC LIMIT 20').all(leadId);
}
