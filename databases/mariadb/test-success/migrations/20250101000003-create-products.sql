-- Migration: Create products table with full e-commerce structure
-- Type: DDL

-- +migrate Up

CREATE TABLE IF NOT EXISTS categories (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    slug VARCHAR(100) NOT NULL,
    parent_id INT UNSIGNED,
    sort_order INT DEFAULT 0,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    
    UNIQUE KEY idx_categories_slug (slug),
    KEY idx_categories_parent (parent_id),
    FOREIGN KEY (parent_id) REFERENCES categories(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS products (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    sku VARCHAR(20) NOT NULL,
    name VARCHAR(200) NOT NULL,
    description TEXT,
    price DECIMAL(10, 2) NOT NULL,
    compare_price DECIMAL(10, 2),
    cost DECIMAL(10, 2),
    category_id INT UNSIGNED,
    status ENUM('draft', 'active', 'discontinued', 'archived') NOT NULL DEFAULT 'draft',
    inventory_quantity INT NOT NULL DEFAULT 0,
    inventory_policy ENUM('deny', 'continue') NOT NULL DEFAULT 'deny',
    weight DECIMAL(8, 2),
    weight_unit ENUM('kg', 'lb', 'oz', 'g') DEFAULT 'kg',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    
    UNIQUE KEY idx_products_sku (sku),
    KEY idx_products_category (category_id),
    KEY idx_products_status (status),
    KEY idx_products_price (price),
    FULLTEXT KEY idx_products_search (name, description),
    FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS product_tags (
    product_id BIGINT UNSIGNED NOT NULL,
    tag VARCHAR(50) NOT NULL,
    
    PRIMARY KEY (product_id, tag),
    KEY idx_product_tags_tag (tag),
    FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- +migrate Down

DROP TABLE IF EXISTS product_tags;
DROP TABLE IF EXISTS products;
DROP TABLE IF EXISTS categories;
