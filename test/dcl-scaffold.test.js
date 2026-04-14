/**
 * Tests for DCLScaffold
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DCLScaffold } from '../src/core/dcl-scaffold.js';

describe('DCLScaffold', () => {
  let scaffold;

  beforeEach(() => {
    scaffold = new DCLScaffold();
  });

  // ─────────────────────────────────────────────────────────────────
  // parseGrantTargets
  // ─────────────────────────────────────────────────────────────────

  describe('parseGrantTargets', () => {
    it('應解析 table-level grant', () => {
      const sql = "GRANT SELECT ON ecommerce.orders TO 'shop_report'@'%'";
      const result = scaffold.parseGrantTargets(sql);
      expect(result).toEqual([{ db: 'ecommerce', table: 'orders' }]);
    });

    it('應解析 db-level grant (db.*)', () => {
      const sql = "GRANT SELECT, INSERT ON ecommerce.* TO 'shop_api'@'%'";
      const result = scaffold.parseGrantTargets(sql);
      expect(result).toEqual([{ db: 'ecommerce', table: null }]);
    });

    it('應排除全域 grant (*.*)', () => {
      const sql = "GRANT USAGE ON *.* TO 'user'@'%'";
      const result = scaffold.parseGrantTargets(sql);
      expect(result).toEqual([]);
    });

    it('應從多個 GRANT 語句中解析出所有 target', () => {
      const sql = `
        GRANT SELECT ON ecommerce.orders TO 'shop_report'@'%';
        GRANT SELECT ON analytics.events TO 'shop_report'@'%';
        GRANT SELECT, INSERT ON ecommerce.* TO 'shop_api'@'%';
      `;
      const result = scaffold.parseGrantTargets(sql);
      expect(result).toHaveLength(3);
      expect(result).toContainEqual({ db: 'ecommerce', table: 'orders' });
      expect(result).toContainEqual({ db: 'analytics', table: 'events' });
      expect(result).toContainEqual({ db: 'ecommerce', table: null });
    });

    it('應去除重複的 target', () => {
      const sql = `
        GRANT SELECT ON ecommerce.orders TO 'user1'@'%';
        GRANT INSERT ON ecommerce.orders TO 'user2'@'%';
      `;
      const result = scaffold.parseGrantTargets(sql);
      expect(result).toHaveLength(1);
      expect(result).toContainEqual({ db: 'ecommerce', table: 'orders' });
    });

    it('應支援 backtick 包裹的名稱', () => {
      const sql = "GRANT SELECT ON `ecommerce`.`orders` TO 'user'@'%'";
      const result = scaffold.parseGrantTargets(sql);
      expect(result).toEqual([{ db: 'ecommerce', table: 'orders' }]);
    });

    it('不含 GRANT 語句時回傳空陣列', () => {
      const sql = "CREATE USER IF NOT EXISTS 'user'@'%' IDENTIFIED BY 'secret'; FLUSH PRIVILEGES;";
      const result = scaffold.parseGrantTargets(sql);
      expect(result).toEqual([]);
    });

    it('同時含有 *.* 和 table-level grant 時只回傳 table-level', () => {
      const sql = `
        GRANT USAGE ON *.* TO 'user'@'%';
        GRANT SELECT ON mydb.mytable TO 'user'@'%';
      `;
      const result = scaffold.parseGrantTargets(sql);
      expect(result).toEqual([{ db: 'mydb', table: 'mytable' }]);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // scaffold
  // ─────────────────────────────────────────────────────────────────

  describe('scaffold', () => {
    it('對 table-level target 應執行 CREATE DATABASE + CREATE TABLE', async () => {
      const mockConn = { execute: vi.fn().mockResolvedValue([[], []]) };
      const result = await scaffold.scaffold(mockConn, [
        { db: 'ecommerce', table: 'orders' }
      ]);

      expect(mockConn.execute).toHaveBeenCalledTimes(2);
      expect(result.databases).toContain('ecommerce');
      expect(result.tables).toContain('ecommerce.orders');
    });

    it('對 db-level target 應只執行 CREATE DATABASE', async () => {
      const mockConn = { execute: vi.fn().mockResolvedValue([[], []]) };
      const result = await scaffold.scaffold(mockConn, [
        { db: 'ecommerce', table: null }
      ]);

      expect(mockConn.execute).toHaveBeenCalledTimes(1);
      expect(result.databases).toContain('ecommerce');
      expect(result.tables).toHaveLength(0);
    });

    it('多個 target 應分別建立', async () => {
      const mockConn = { execute: vi.fn().mockResolvedValue([[], []]) };
      await scaffold.scaffold(mockConn, [
        { db: 'ecommerce', table: 'orders' },
        { db: 'analytics', table: 'events' },
        { db: 'ecommerce', table: null }
      ]);

      // 2 table-level targets × 2 calls each + 1 db-level target × 1 call = 5
      expect(mockConn.execute).toHaveBeenCalledTimes(5);
    });

    it('空 targets 陣列時不呼叫 execute', async () => {
      const mockConn = { execute: vi.fn() };
      const result = await scaffold.scaffold(mockConn, []);
      expect(mockConn.execute).not.toHaveBeenCalled();
      expect(result.databases).toHaveLength(0);
      expect(result.tables).toHaveLength(0);
    });

    it('CREATE DATABASE SQL 應包含 IF NOT EXISTS', async () => {
      const mockConn = { execute: vi.fn().mockResolvedValue([[], []]) };
      await scaffold.scaffold(mockConn, [{ db: 'testdb', table: null }]);
      const sql = mockConn.execute.mock.calls[0][0];
      expect(sql).toMatch(/CREATE DATABASE IF NOT EXISTS/i);
      expect(sql).toMatch(/`testdb`/);
    });

    it('CREATE TABLE SQL 應包含 IF NOT EXISTS', async () => {
      const mockConn = { execute: vi.fn().mockResolvedValue([[], []]) };
      await scaffold.scaffold(mockConn, [{ db: 'testdb', table: 'mytable' }]);
      const createTableSql = mockConn.execute.mock.calls[1][0];
      expect(createTableSql).toMatch(/CREATE TABLE IF NOT EXISTS/i);
      expect(createTableSql).toMatch(/`testdb`\.`mytable`/);
    });

    it('databases 陣列不重複相同的 db', async () => {
      const mockConn = { execute: vi.fn().mockResolvedValue([[], []]) };
      const result = await scaffold.scaffold(mockConn, [
        { db: 'ecommerce', table: 'orders' },
        { db: 'ecommerce', table: 'products' }
      ]);
      const ecommerceCount = result.databases.filter(d => d === 'ecommerce').length;
      expect(ecommerceCount).toBe(1);
      expect(result.tables).toContain('ecommerce.orders');
      expect(result.tables).toContain('ecommerce.products');
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // scaffoldForDCL
  // ─────────────────────────────────────────────────────────────────

  describe('scaffoldForDCL', () => {
    it('應整合多個 SQL 內容並去重', async () => {
      const mockConn = { execute: vi.fn().mockResolvedValue([[], []]) };

      const sqlContents = [
        "GRANT SELECT ON ecommerce.orders TO 'user1'@'%';",
        "GRANT SELECT ON analytics.events TO 'user2'@'%'; GRANT INSERT ON ecommerce.orders TO 'user3'@'%';"
      ];

      await scaffold.scaffoldForDCL(mockConn, sqlContents);

      // ecommerce.orders appears twice across files but should be scaffolded once
      // Unique table-level targets: ecommerce.orders, analytics.events → 4 execute calls
      expect(mockConn.execute).toHaveBeenCalledTimes(4);
    });

    it('空 SQL 陣列時不呼叫 execute', async () => {
      const mockConn = { execute: vi.fn() };
      const result = await scaffold.scaffoldForDCL(mockConn, []);
      expect(mockConn.execute).not.toHaveBeenCalled();
      expect(result.databases).toHaveLength(0);
      expect(result.tables).toHaveLength(0);
    });

    it('只有 *.* grant 時不呼叫 execute', async () => {
      const mockConn = { execute: vi.fn() };
      const result = await scaffold.scaffoldForDCL(mockConn, ["GRANT USAGE ON *.* TO 'user'@'%';"]);
      expect(mockConn.execute).not.toHaveBeenCalled();
      expect(result.tables).toHaveLength(0);
    });

    it('應回傳所有建立的 databases 和 tables', async () => {
      const mockConn = { execute: vi.fn().mockResolvedValue([[], []]) };

      const sqlContents = [
        "GRANT SELECT ON ecommerce.orders TO 'shop_report'@'%';",
        "GRANT SELECT ON analytics.events TO 'shop_report'@'%';"
      ];

      const result = await scaffold.scaffoldForDCL(mockConn, sqlContents);
      expect(result.databases).toContain('ecommerce');
      expect(result.databases).toContain('analytics');
      expect(result.tables).toContain('ecommerce.orders');
      expect(result.tables).toContain('analytics.events');
    });

    it('多個檔案內容中重複的 target 應只建立一次', async () => {
      const mockConn = { execute: vi.fn().mockResolvedValue([[], []]) };

      // Same grant in 3 files
      const sqlContents = [
        "GRANT SELECT ON db1.tbl1 TO 'u1'@'%';",
        "GRANT SELECT ON db1.tbl1 TO 'u2'@'%';",
        "GRANT INSERT ON db1.tbl1 TO 'u3'@'%';"
      ];

      const result = await scaffold.scaffoldForDCL(mockConn, sqlContents);
      // Only 1 unique target: db1.tbl1 → 2 execute calls
      expect(mockConn.execute).toHaveBeenCalledTimes(2);
      expect(result.tables).toHaveLength(1);
    });
  });
});
