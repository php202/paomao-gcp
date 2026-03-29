-- SayDou 交易同步系統
-- 2026-03-23 建立

-- 核心交易表：SayDou 原始資料的鏡像
CREATE TABLE IF NOT EXISTS saydou_transactions (
    ordrsn          TEXT PRIMARY KEY,           -- 訂單編號（SayDou 唯一識別）
    store_id        INT NOT NULL,               -- SayDou 門市 ID
    store_name      TEXT NOT NULL,
    order_date      DATE NOT NULL,              -- 交易日期
    order_time      TEXT,                        -- 交易時間 (HH:MM)
    member_id       INT,                         -- 會員 ID
    member_name     TEXT,
    member_phone    TEXT,
    total_amount    NUMERIC(10,2) DEFAULT 0,    -- 訂單總金額
    payment_type    TEXT,                        -- 付款方式
    status          TEXT,                        -- 訂單狀態
    items           JSONB NOT NULL DEFAULT '[]', -- ordds 完整明細（商品/服務/操作人員）
    raw_data        JSONB,                       -- SayDou 原始 JSON（完整備份）
    synced_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    is_deleted      BOOLEAN DEFAULT FALSE        -- SayDou 刪單標記
);

-- 索引：常用查詢路徑
CREATE INDEX IF NOT EXISTS idx_saydou_tx_store_date ON saydou_transactions (store_id, order_date);
CREATE INDEX IF NOT EXISTS idx_saydou_tx_date ON saydou_transactions (order_date);
CREATE INDEX IF NOT EXISTS idx_saydou_tx_member ON saydou_transactions (member_id);
CREATE INDEX IF NOT EXISTS idx_saydou_tx_items ON saydou_transactions USING GIN (items);
CREATE INDEX IF NOT EXISTS idx_saydou_tx_updated ON saydou_transactions (updated_at);

-- 同步紀錄表：追蹤每次同步的狀態
CREATE TABLE IF NOT EXISTS saydou_sync_log (
    id              SERIAL PRIMARY KEY,
    store_id        INT NOT NULL,
    store_name      TEXT,
    sync_date       DATE NOT NULL,              -- 同步的目標日期
    sync_type       TEXT NOT NULL,               -- 'incremental' | 'backfill' | 'resync'
    tx_fetched      INT DEFAULT 0,              -- API 拉到幾筆
    tx_upserted     INT DEFAULT 0,              -- 實際寫入/更新幾筆
    tx_deleted      INT DEFAULT 0,              -- 標記刪除幾筆
    started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    finished_at     TIMESTAMPTZ,
    status          TEXT DEFAULT 'running',      -- 'running' | 'success' | 'error'
    error_message   TEXT,
    UNIQUE(store_id, sync_date, sync_type, started_at)
);

-- 重跑請求表：店長改單後觸發重跑
CREATE TABLE IF NOT EXISTS saydou_resync_requests (
    id              SERIAL PRIMARY KEY,
    store_id        INT NOT NULL,
    store_name      TEXT,
    resync_date     DATE NOT NULL,              -- 要重跑哪天
    requested_by    TEXT,                        -- 誰觸發的
    requested_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    processed_at    TIMESTAMPTZ,
    status          TEXT DEFAULT 'pending',      -- 'pending' | 'processing' | 'done' | 'error'
    note            TEXT
);

-- =====================================================
-- daily_accounting VIEW：從交易自動衍生，不另存
-- 店長改單 → 重跑同步 → 交易更新 → VIEW 自動正確
-- =====================================================
CREATE OR REPLACE VIEW daily_accounting AS
SELECT
    t.store_id,
    t.store_name,
    t.order_date AS date,
    COUNT(*) AS tx_count,
    SUM(t.total_amount) AS total_amount,
    -- 從 items JSONB 拆解各類金額
    SUM(CASE WHEN item->>'payment_type' = 'cash' OR t.payment_type ILIKE '%現金%'
        THEN t.total_amount ELSE 0 END) AS cash_total,
    SUM(CASE WHEN t.payment_type ILIKE '%刷卡%' OR t.payment_type ILIKE '%信用%'
        THEN t.total_amount ELSE 0 END) AS card_total,
    SUM(CASE WHEN t.payment_type ILIKE '%儲值%'
        THEN t.total_amount ELSE 0 END) AS stored_value_total,
    -- 商品/服務拆解
    SUM((SELECT COALESCE(SUM((i->>'rprice')::numeric), 0)
         FROM jsonb_array_elements(t.items) i
         WHERE i->>'godnam' IS NOT NULL
           AND i->>'godnam' NOT ILIKE '%面膜%'
           AND i->>'godtyp' != 'product')) AS service_amount,
    SUM((SELECT COALESCE(SUM((i->>'rprice')::numeric), 0)
         FROM jsonb_array_elements(t.items) i
         WHERE i->>'godtyp' = 'product')) AS product_amount
FROM saydou_transactions t
LEFT JOIN LATERAL jsonb_array_elements(t.items) item ON true
WHERE t.is_deleted = FALSE
GROUP BY t.store_id, t.store_name, t.order_date;

-- 方便查詢的 function：某門市某天的帳表
CREATE OR REPLACE FUNCTION get_daily_report(p_store_id INT, p_date DATE)
RETURNS TABLE (
    store_name TEXT,
    tx_count BIGINT,
    total_amount NUMERIC,
    cash_total NUMERIC,
    card_total NUMERIC,
    stored_value_total NUMERIC,
    service_amount NUMERIC,
    product_amount NUMERIC
) AS $$
BEGIN
    RETURN QUERY
    SELECT da.store_name, da.tx_count, da.total_amount,
           da.cash_total, da.card_total, da.stored_value_total,
           da.service_amount, da.product_amount
    FROM daily_accounting da
    WHERE da.store_id = p_store_id AND da.date = p_date;
END;
$$ LANGUAGE plpgsql;
