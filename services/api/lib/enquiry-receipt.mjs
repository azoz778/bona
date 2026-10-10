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

export function recoverPendingNotifications(db) {
 return db.transaction(() => ({
  enquiries: db.db.prepare("UPDATE enquiry_receipts SET notify_status='uncertain' WHERE notify_status='pending'").run().changes,
  handoffs: db.db.prepare("UPDATE lead_tasks SET telegram_status='uncertain' WHERE telegram_status='pending'").run().changes,
 }));
}

export function enquiryNotifications(db, leadId) {
 return db.db.prepare('SELECT event_id,created,notify_status FROM enquiry_receipts WHERE lead_id=? ORDER BY created DESC LIMIT 20').all(leadId);
}
