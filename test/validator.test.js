/**
 * Integration Test for MQL Validator
 */

import { describe, it, expect } from 'vitest';
import { MQLValidator } from '../src/validators/mql-validator.js';
import fs from 'fs/promises';
import path from 'path';

describe('MQL Validator', () => {
  describe('Forbidden Operations Detection', () => {
    it('should reject dropDatabase operation', () => {
      const content = `
        export async function up(db) {
          await db.dropDatabase();
        }
      `;
      
      const validator = new MQLValidator();
      const result = validator.validateContent(content, 'test.js');
      
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors.some(e => e.message.includes('dropDatabase'))).toBe(true);
    });
    
    it('should reject createUser operation', () => {
      const content = `
        export async function up(db) {
          await db.createUser({ user: 'test', pwd: 'test' });
        }
      `;
      
      const validator = new MQLValidator();
      const result = validator.validateContent(content, 'test.js');
      
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors.some(e => e.message.includes('createUser'))).toBe(true);
    });
    
    it('should accept valid migration', () => {
      const content = `
        export async function up(db) {
          await db.collection('users').createIndex({ email: 1 });
        }
      `;
      
      const validator = new MQLValidator();
      const result = validator.validateContent(content, 'test.js');
      
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });
  });
  
  describe('Warning Operations Detection', () => {
    it('should warn about deleteMany operation', () => {
      const content = `
        export async function down(db) {
          await db.collection('temp').deleteMany({});
        }
      `;
      
      const validator = new MQLValidator();
      const result = validator.validateContent(content, 'test.js');
      
      expect(result.valid).toBe(true);
      expect(result.warnings.length).toBeGreaterThan(0);
      expect(result.warnings.some(w => w.message.includes('deleteMany'))).toBe(true);
    });
  });
  
  describe('Custom Validation Rules', () => {
    it('should enforce custom rules', () => {
      const content = `
        export async function up(db) {
          await db.collection('temp').drop();
        }
      `;
      
      const customRules = {
        forbidden: {
          database: [],
          collections: [],
          system: [],
          admin: [],
        },
        custom: [
          {
            name: 'noDropInUp',
            message: 'Cannot use drop() in up function',
            check: (content) => {
              return !content.includes('.drop()');
            }
          }
        ],
        warnings: {
          operations: []
        }
      };
      
      const validator = new MQLValidator(customRules);
      const result = validator.validateContent(content, 'test.js');
      
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.rule === 'noDropInUp')).toBe(true);
    });
  });
  
  describe('File Validation', () => {
    it('should validate sample migration file', async () => {
      const validator = new MQLValidator();
      const result = await validator.validateFile('migrations/sample-migration.js');
      
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });
  });
});
