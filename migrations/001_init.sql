CREATE TABLE IF NOT EXISTS tenants (
  id VARCHAR(64) PRIMARY KEY,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
);

CREATE TABLE IF NOT EXISTS aggregates (
  tenant_id VARCHAR(64) NOT NULL,
  kind VARCHAR(32) NOT NULL,
  id VARCHAR(64) NOT NULL,
  doc JSON NOT NULL,
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (tenant_id, kind, id),
  CONSTRAINT fk_agg_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);

CREATE TABLE IF NOT EXISTS sequences (
  tenant_id VARCHAR(64) NOT NULL,
  name VARCHAR(64) NOT NULL,
  value BIGINT NOT NULL,
  PRIMARY KEY (tenant_id, name)
);

CREATE TABLE IF NOT EXISTS jobs (
  id CHAR(36) PRIMARY KEY,
  tenant_id VARCHAR(64) NOT NULL,
  type VARCHAR(64) NOT NULL,
  payload JSON NOT NULL,
  status ENUM('queued','running','done','paused','failed') NOT NULL DEFAULT 'queued',
  attempts INT NOT NULL DEFAULT 0,
  locked_by VARCHAR(128) NULL,
  locked_at TIMESTAMP(3) NULL,
  last_error TEXT NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_jobs_claim (status, type, created_at)
);

CREATE TABLE IF NOT EXISTS notifications (
  cursor_id BIGINT AUTO_INCREMENT PRIMARY KEY,
  tenant_id VARCHAR(64) NOT NULL,
  type VARCHAR(64) NOT NULL,
  message TEXT NOT NULL,
  data JSON NOT NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  acknowledged_at TIMESTAMP(3) NULL,
  KEY idx_notif_tenant (tenant_id, cursor_id)
);

CREATE TABLE IF NOT EXISTS audit_log (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  tenant_id VARCHAR(64) NOT NULL,
  actor VARCHAR(64) NOT NULL,
  action VARCHAR(128) NOT NULL,
  detail JSON NOT NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_audit_tenant (tenant_id, id)
);

CREATE TABLE IF NOT EXISTS receipts (
  tenant_id VARCHAR(64) NOT NULL,
  idem_key VARCHAR(191) NOT NULL,
  result JSON NOT NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (tenant_id, idem_key)
);
