-- @description: Stored Procedures and Functions for the application
-- @type: procedure
-- @allow-dangerous: true
--
-- This file demonstrates:
-- 1. DELIMITER support for stored procedures
-- 2. Idempotent procedure creation using DROP IF EXISTS
-- ============================================

-- Function: Calculate age from birthdate
DELIMITER //

DROP FUNCTION IF EXISTS fn_calculate_age//

CREATE FUNCTION fn_calculate_age(birthdate DATE)
RETURNS INT
DETERMINISTIC
BEGIN
    DECLARE age INT;
    SET age = TIMESTAMPDIFF(YEAR, birthdate, CURDATE());
    RETURN age;
END//

DELIMITER ;

-- Procedure: Get user statistics
DELIMITER //

DROP PROCEDURE IF EXISTS sp_get_user_stats//

CREATE PROCEDURE sp_get_user_stats(
    IN p_user_id INT,
    OUT p_order_count INT,
    OUT p_total_spent DECIMAL(10,2)
)
BEGIN
    -- Get order count
    SELECT COUNT(*) INTO p_order_count
    FROM orders
    WHERE user_id = p_user_id;
    
    -- Get total spent (handle NULL)
    SELECT COALESCE(SUM(total_amount), 0) INTO p_total_spent
    FROM orders
    WHERE user_id = p_user_id;
END//

DELIMITER ;

-- Procedure: Log audit event (example with multiple statements)
DELIMITER $$

DROP PROCEDURE IF EXISTS sp_log_audit$$

CREATE PROCEDURE sp_log_audit(
    IN p_table_name VARCHAR(100),
    IN p_action VARCHAR(50),
    IN p_record_id INT,
    IN p_user_id INT
)
BEGIN
    -- Create audit table if not exists
    CREATE TABLE IF NOT EXISTS audit_log (
        id INT AUTO_INCREMENT PRIMARY KEY,
        table_name VARCHAR(100),
        action VARCHAR(50),
        record_id INT,
        user_id INT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    
    -- Insert audit record
    INSERT INTO audit_log (table_name, action, record_id, user_id)
    VALUES (p_table_name, p_action, p_record_id, p_user_id);
END$$

DELIMITER ;
