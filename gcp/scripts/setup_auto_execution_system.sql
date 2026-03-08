-- 建立建議箱自動執行系統資料表
BEGIN;

-- 1. 自動執行記錄表
CREATE TABLE IF NOT EXISTS suggestion_executions (
    id SERIAL PRIMARY KEY,
    execution_batch VARCHAR(50) NOT NULL,  -- 批次編號 AE202603051
    suggestion_ids INTEGER[] NOT NULL,     -- 執行的建議ID陣列
    trigger_condition VARCHAR(100),        -- 觸發條件
    
    -- 執行狀態
    status VARCHAR(20) DEFAULT 'pending',  -- pending, analyzing, executing, completed, failed
    analysis_result JSONB,                 -- AI分析結果
    execution_plan JSONB,                  -- 執行計劃
    execution_result JSONB,                -- 執行結果
    
    -- 時間記錄
    triggered_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    analyzed_at TIMESTAMP,
    started_at TIMESTAMP,
    completed_at TIMESTAMP,
    
    -- 執行資訊
    executed_by VARCHAR(100) DEFAULT 'AutoSystem',
    total_suggestions INTEGER,
    successful_actions INTEGER DEFAULT 0,
    failed_actions INTEGER DEFAULT 0,
    
    -- 執行日誌
    execution_log TEXT,
    error_message TEXT,
    
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 2. 建議執行動作表
CREATE TABLE IF NOT EXISTS suggestion_actions (
    id SERIAL PRIMARY KEY,
    execution_id INTEGER REFERENCES suggestion_executions(id) ON DELETE CASCADE,
    suggestion_id INTEGER REFERENCES suggestions(id),
    
    -- 動作資訊
    action_type VARCHAR(50) NOT NULL,      -- database_update, file_modify, api_call, system_config
    action_description TEXT NOT NULL,
    action_data JSONB,                     -- 動作的具體資料
    
    -- 執行狀態
    status VARCHAR(20) DEFAULT 'pending',  -- pending, executing, completed, failed, skipped
    result JSONB,                          -- 執行結果
    error_message TEXT,
    
    -- 執行時間
    started_at TIMESTAMP,
    completed_at TIMESTAMP,
    execution_duration_ms INTEGER,
    
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 3. 自動執行配置表
CREATE TABLE IF NOT EXISTS auto_execution_config (
    id SERIAL PRIMARY KEY,
    config_key VARCHAR(100) UNIQUE NOT NULL,
    config_value JSONB NOT NULL,
    description TEXT,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 4. 建議分類執行規則表
CREATE TABLE IF NOT EXISTS suggestion_execution_rules (
    id SERIAL PRIMARY KEY,
    category_pattern VARCHAR(100),         -- 分類匹配規則
    title_pattern VARCHAR(200),           -- 標題匹配規則
    description_pattern VARCHAR(500),     -- 描述匹配規則
    
    -- 執行規則
    action_type VARCHAR(50) NOT NULL,
    is_auto_executable BOOLEAN DEFAULT FALSE,
    requires_manual_review BOOLEAN DEFAULT TRUE,
    risk_level INTEGER DEFAULT 3,         -- 1-5, 風險等級
    
    -- 執行模板
    action_template JSONB,                -- 動作模板
    validation_rules JSONB,               -- 驗證規則
    
    -- 規則設定
    is_active BOOLEAN DEFAULT TRUE,
    priority INTEGER DEFAULT 5,
    
    created_by VARCHAR(100),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 插入基本配置
INSERT INTO auto_execution_config (config_key, config_value, description) VALUES
('trigger_threshold', '5', '觸發自動執行的採納建議數量'),
('max_concurrent_executions', '3', '最大同時執行數'),
('execution_timeout_minutes', '30', '執行超時時間（分鐘）'),
('auto_execution_enabled', 'true', '是否啟用自動執行'),
('notification_channels', '["telegram"]', '通知渠道'),
('risk_level_threshold', '3', '允許自動執行的最大風險等級');

-- 插入基本執行規則
INSERT INTO suggestion_execution_rules (
    category_pattern, title_pattern, action_type, is_auto_executable, risk_level, 
    action_template, created_by
) VALUES
-- 資料庫更新類
('頁面建議', '%門市%資料%', 'database_update', true, 2, 
 '{"type": "add_columns", "table": "stores", "fields": ["service_fee", "sign_size", "media_number"]}', 'System'),

-- 頁面修復類  
('頁面建議', '%載入%失敗%', 'code_fix', true, 2,
 '{"type": "fix_loading_error", "component": "attendance", "area": "hq"}', 'System'),
 
-- 過濾條件類
('頁面建議', '%店長%加盟店%', 'filter_update', true, 1,
 '{"type": "update_filter", "component": "manager_dashboard", "filter": "franchise_only"}', 'System'),

-- 錯誤修復類
('頁面建議', '%錯誤%', 'bug_fix', true, 3,
 '{"type": "generic_error_fix", "priority": "high"}', 'System');

-- 建立索引
CREATE INDEX IF NOT EXISTS idx_suggestion_executions_status ON suggestion_executions(status);
CREATE INDEX IF NOT EXISTS idx_suggestion_executions_triggered ON suggestion_executions(triggered_at);
CREATE INDEX IF NOT EXISTS idx_suggestion_actions_execution ON suggestion_actions(execution_id);
CREATE INDEX IF NOT EXISTS idx_suggestion_actions_status ON suggestion_actions(status);

-- 建立觸發器
CREATE OR REPLACE FUNCTION update_execution_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER suggestion_executions_updated_at
    BEFORE UPDATE ON suggestion_executions
    FOR EACH ROW EXECUTE FUNCTION update_execution_updated_at();

CREATE TRIGGER auto_execution_config_updated_at
    BEFORE UPDATE ON auto_execution_config
    FOR EACH ROW EXECUTE FUNCTION update_execution_updated_at();

COMMIT;

-- 顯示建立結果
SELECT 'suggestion_executions' as table_name, COUNT(*) as record_count FROM suggestion_executions
UNION ALL
SELECT 'suggestion_actions', COUNT(*) FROM suggestion_actions
UNION ALL
SELECT 'auto_execution_config', COUNT(*) FROM auto_execution_config
UNION ALL
SELECT 'suggestion_execution_rules', COUNT(*) FROM suggestion_execution_rules;