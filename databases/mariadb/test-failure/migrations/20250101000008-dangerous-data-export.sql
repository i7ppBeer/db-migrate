-- 測試：危險的資料匯出操作
-- 預期驗證結果：失敗（資料匯出是潛在危險操作）

-- +migrate Up
CREATE TABLE IF NOT EXISTS sensitive_data (
    id INT AUTO_INCREMENT PRIMARY KEY,
    ssn VARCHAR(11),
    credit_card VARCHAR(19),
    data TEXT
);

-- 危險操作: 匯出資料到檔案（資料外洩風險）
SELECT * INTO OUTFILE '/tmp/exported_data.csv'
FIELDS TERMINATED BY ','
FROM sensitive_data;

-- 危險操作: 載入外部資料（注入風險）
LOAD DATA INFILE '/tmp/malicious.csv'
INTO TABLE sensitive_data
FIELDS TERMINATED BY ',';

-- +migrate Down
DROP TABLE IF EXISTS sensitive_data;
