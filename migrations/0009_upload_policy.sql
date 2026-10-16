-- Ordinary upload no longer uses account-risk permissions. Preserve all audit
-- records, completed objects and live multipart reservations.
UPDATE reservations SET state='released',released_at=CAST(strftime('%s','now') AS INTEGER)*1000
 WHERE kind='upload_approval' AND state='reserved';
UPDATE upload_approval_files SET reserved_bytes=0,claim_token=NULL;
UPDATE upload_approvals SET state='expired',expires_at=MIN(expires_at,CAST(strftime('%s','now') AS INTEGER)*1000)
 WHERE state!='expired';
-- Never reuse an unexecuted quote from the retired admission policy.
UPDATE quotes SET state='expired' WHERE state='open';
