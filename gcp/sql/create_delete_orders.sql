-- 刪單管理表
CREATE TABLE IF NOT EXISTS delete_orders (
  id SERIAL PRIMARY KEY,
  customer_name TEXT NOT NULL,
  phone TEXT NOT NULL,
  order_id TEXT NOT NULL,
  amount NUMERIC(10,2),
  reason TEXT,
  saydou_member_id TEXT,          -- SayDou 會員 ID
  saydou_ordcid TEXT,             -- SayDou 訂單 ordcid
  source_group_id TEXT,           -- 來源 LINE 群組 ID
  source_group_name TEXT,         -- 來源 LINE 群組名稱
  requested_by TEXT,              -- 提交人 LINE 顯示名稱
  requested_by_user_id TEXT,      -- 提交人 LINE User ID
  status TEXT DEFAULT 'pending',  -- pending/deleted/not_found/failed
  deleted_by TEXT,                -- 誰確認刪除的（Dashboard 登入帳號）
  deleted_at TIMESTAMP,
  error_message TEXT,             -- 錯誤訊息（如果刪除失敗）
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- 建立索引
CREATE INDEX IF NOT EXISTS idx_delete_orders_status ON delete_orders(status);
CREATE INDEX IF NOT EXISTS idx_delete_orders_created_at ON delete_orders(created_at);
CREATE INDEX IF NOT EXISTS idx_delete_orders_phone ON delete_orders(phone);
CREATE INDEX IF NOT EXISTS idx_delete_orders_order_id ON delete_orders(order_id);

-- 更新時間觸發器
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_delete_orders_updated_at BEFORE UPDATE
    ON delete_orders FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();