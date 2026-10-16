-- Bound billing-period reads independently of the ledger's permanent history.
CREATE INDEX resource_usage_daily_time ON resource_usage_daily(scope,day_start);
