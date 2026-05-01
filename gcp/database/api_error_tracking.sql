-- API 錯誤追蹤系統
-- 用於記錄所有 API 呼叫的錯誤，方便分析和修正

-- API 錯誤日誌表
CREATE TABLE IF NOT EXISTS api_error_logs (
    id SERIAL PRIMARY KEY,
    
    -- 基本資訊
    api_name VARCHAR(100) NOT NULL,           -- API 名稱 (如 'giveme-invoice', 'saydou-delete')
    endpoint VARCHAR(500),                     -- API 端點 URL
    method VARCHAR(10),                        -- HTTP 方法 (GET, POST, PUT, DELETE)
    
    -- 請求資訊
    request_params JSONB,                      -- 請求參數
    request_headers JSONB,                     -- 請求 headers
    
    -- 錯誤資訊
    error_type VARCHAR(50),                    -- 錯誤類型 ('HTTP_ERROR', 'TIMEOUT', 'NETWORK_ERROR', 'PARSE_ERROR')
    http_status_code INTEGER,                  -- HTTP 狀態碼
    error_message TEXT,                        -- 錯誤訊息
    error_details JSONB,                       -- 詳細錯誤資訊
    
    -- 呼叫者資訊
    caller_script VARCHAR(100),                -- 呼叫的腳本/模組名稱
    caller_function VARCHAR(100),              -- 呼叫的函數名稱
    user_name VARCHAR(50),                     -- 操作用戶
    
    -- 時間資訊
    occurred_at TIMESTAMP DEFAULT NOW(),      -- 發生時間
    retry_count INTEGER DEFAULT 0,            -- 重試次數
    
    -- 解決狀態
    resolved BOOLEAN DEFAULT FALSE,           -- 是否已解決
    resolved_at TIMESTAMP,                    -- 解決時間
    resolution_notes TEXT                     -- 解決說明
);

-- API 錯誤統計表 (彙總資料)
CREATE TABLE IF NOT EXISTS api_error_stats (
    id SERIAL PRIMARY KEY,
    
    api_name VARCHAR(100) NOT NULL,
    error_type VARCHAR(50) NOT NULL,
    date DATE NOT NULL,
    
    -- 統計數據
    error_count INTEGER DEFAULT 1,
    first_occurred_at TIMESTAMP,
    last_occurred_at TIMESTAMP,
    
    -- 狀態
    status VARCHAR(20) DEFAULT 'active',     -- 'active', 'investigating', 'resolved'
    alert_sent BOOLEAN DEFAULT FALSE,        -- 是否已發送警報
    
    UNIQUE(api_name, error_type, date)
);

-- 建立索引
CREATE INDEX IF NOT EXISTS idx_api_error_logs_api_name ON api_error_logs(api_name);
CREATE INDEX IF NOT EXISTS idx_api_error_logs_occurred_at ON api_error_logs(occurred_at);
CREATE INDEX IF NOT EXISTS idx_api_error_logs_error_type ON api_error_logs(error_type);
CREATE INDEX IF NOT EXISTS idx_api_error_logs_caller ON api_error_logs(caller_script, caller_function);
CREATE INDEX IF NOT EXISTS idx_api_error_logs_resolved ON api_error_logs(resolved, occurred_at);

CREATE INDEX IF NOT EXISTS idx_api_error_stats_api_date ON api_error_stats(api_name, date);
CREATE INDEX IF NOT EXISTS idx_api_error_stats_status ON api_error_stats(status);

-- 插入錯誤日誌的函數
CREATE OR REPLACE FUNCTION log_api_error(
    p_api_name VARCHAR(100),
    p_endpoint VARCHAR(500),
    p_method VARCHAR(10),
    p_request_params JSONB,
    p_error_type VARCHAR(50),
    p_http_status_code INTEGER,
    p_error_message TEXT,
    p_caller_script VARCHAR(100),
    p_caller_function VARCHAR(100) DEFAULT NULL,
    p_user_name VARCHAR(50) DEFAULT NULL
) RETURNS INTEGER AS $$
DECLARE
    new_log_id INTEGER;
    today DATE := CURRENT_DATE;
BEGIN
    -- 插入錯誤日誌
    INSERT INTO api_error_logs (
        api_name, endpoint, method, request_params, 
        error_type, http_status_code, error_message,
        caller_script, caller_function, user_name
    ) VALUES (
        p_api_name, p_endpoint, p_method, p_request_params,
        p_error_type, p_http_status_code, p_error_message,
        p_caller_script, p_caller_function, p_user_name
    ) RETURNING id INTO new_log_id;
    
    -- 更新統計
    INSERT INTO api_error_stats (
        api_name, error_type, date, 
        error_count, first_occurred_at, last_occurred_at
    ) VALUES (
        p_api_name, p_error_type, today,
        1, NOW(), NOW()
    )
    ON CONFLICT (api_name, error_type, date) DO UPDATE SET
        error_count = api_error_stats.error_count + 1,
        last_occurred_at = NOW();
    
    RETURN new_log_id;
END;
$$ LANGUAGE plpgsql;

COMMENT ON TABLE api_error_logs IS 'API 錯誤詳細日誌，記錄每次 API 呼叫失敗的詳細資訊';
COMMENT ON TABLE api_error_stats IS 'API 錯誤統計彙總，按 API 名稱、錯誤類型、日期分組統計';
COMMENT ON FUNCTION log_api_error IS '記錄 API 錯誤的便利函數，會同時更新日誌和統計表';