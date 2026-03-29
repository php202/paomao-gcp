-- SayDou 同步系統升級：重跑機制 + 帳務 VIEW
-- 2026-03-23

-- 1. 補欄位
ALTER TABLE saydou_transactions ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();
ALTER TABLE saydou_transactions ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN DEFAULT FALSE;
ALTER TABLE saydou_transactions ADD COLUMN IF NOT EXISTS memphone VARCHAR(20);
ALTER TABLE saydou_transactions ADD COLUMN IF NOT EXISTS payment_type VARCHAR(50);
ALTER TABLE saydou_transactions ADD COLUMN IF NOT EXISTS order_date DATE;
ALTER TABLE saydou_transactions ADD COLUMN IF NOT EXISTS order_time VARCHAR(8);

-- 回填 order_date 從 rectim
UPDATE saydou_transactions SET order_date = rectim::date WHERE order_date IS NULL AND rectim IS NOT NULL;
UPDATE saydou_transactions SET order_time = to_char(rectim, 'HH24:MI') WHERE order_time IS NULL AND rectim IS NOT NULL;

-- 2. 補索引
CREATE INDEX IF NOT EXISTS idx_saydou_tx_order_date ON saydou_transactions (order_date);
CREATE INDEX IF NOT EXISTS idx_saydou_tx_store_date ON saydou_transactions (storid, order_date);
CREATE INDEX IF NOT EXISTS idx_saydou_tx_updated ON saydou_transactions (updated_at);
CREATE INDEX IF NOT EXISTS idx_saydou_tx_deleted ON saydou_transactions (is_deleted) WHERE is_deleted = TRUE;

-- 3. 同步紀錄表
CREATE TABLE IF NOT EXISTS saydou_sync_log (
    id              SERIAL PRIMARY KEY,
    store_id        INT NOT NULL,
    store_name      TEXT,
    sync_date       DATE NOT NULL,
    sync_type       TEXT NOT NULL DEFAULT 'incremental',  -- incremental | backfill | resync
    tx_fetched      INT DEFAULT 0,
    tx_upserted     INT DEFAULT 0,
    tx_deleted      INT DEFAULT 0,
    started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    finished_at     TIMESTAMPTZ,
    status          TEXT DEFAULT 'running',  -- running | success | error
    error_message   TEXT
);

-- 4. 重跑請求表：店長改單 → 重跑 → 帳表自動修正
CREATE TABLE IF NOT EXISTS saydou_resync_requests (
    id              SERIAL PRIMARY KEY,
    store_id        INT NOT NULL,
    store_name      TEXT,
    resync_date     DATE NOT NULL,
    requested_by    TEXT,
    requested_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    processed_at    TIMESTAMPTZ,
    status          TEXT DEFAULT 'pending',  -- pending | processing | done | error
    note            TEXT
);

-- 5. 每日帳表 VIEW（從交易自動衍生，交易改了帳表自動對）
DROP VIEW IF EXISTS daily_accounting;
CREATE VIEW daily_accounting AS
SELECT
    t.storid AS store_id,
    t.store_name,
    t.order_date AS date,
    COUNT(*) AS tx_count,
    SUM(t.rprice) AS total_amount,
    SUM(t.cash) AS cash_total,
    SUM(t.card) AS card_total,
    SUM(t.ticket) AS ticket_total,
    SUM(t.rpcash) AS stored_value_total,  -- 儲值金
    SUM(t.give) AS give_total,            -- 贈品/折抵
    SUM(t.free) AS free_total             -- 免費
FROM saydou_transactions t
WHERE t.is_deleted = FALSE
GROUP BY t.storid, t.store_name, t.order_date;

-- 6. 方便的查詢 function
CREATE OR REPLACE FUNCTION get_daily_report(p_store_id INT, p_date DATE)
RETURNS TABLE (
    store_name TEXT,
    tx_count BIGINT,
    total_amount NUMERIC,
    cash_total NUMERIC,
    card_total NUMERIC,
    ticket_total NUMERIC,
    stored_value_total NUMERIC
) AS $$
BEGIN
    RETURN QUERY
    SELECT da.store_name, da.tx_count, da.total_amount,
           da.cash_total, da.card_total, da.ticket_total,
           da.stored_value_total
    FROM daily_accounting da
    WHERE da.store_id = p_store_id AND da.date = p_date;
END;
$$ LANGUAGE plpgsql;

-- 7. 重跑觸發 function（供 API 呼叫）
CREATE OR REPLACE FUNCTION request_resync(
    p_store_id INT,
    p_store_name TEXT,
    p_date DATE,
    p_requested_by TEXT DEFAULT 'system'
) RETURNS INT AS $$
DECLARE
    v_id INT;
BEGIN
    INSERT INTO saydou_resync_requests (store_id, store_name, resync_date, requested_by)
    VALUES (p_store_id, p_store_name, p_date, p_requested_by)
    RETURNING id INTO v_id;
    RETURN v_id;
END;
$$ LANGUAGE plpgsql;
