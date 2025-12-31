/**
 * MQL Validator
 * Validates migration files to ensure they only contain allowed operations
 */

import fs from 'fs/promises';
import path from 'path';
import { validationRules } from '../config/validation-rules.js';

export class MQLValidator {
  constructor(ruleOverrides = null, options = {}) {
    // Deep copy default rules to avoid mutation
    this.rules = JSON.parse(JSON.stringify(validationRules));
    
    if (ruleOverrides) {
      this.updateRules(ruleOverrides);
    }
    
    this.options = options;
  }

  /**
   * Validate a migration file
   * @param {string} filePath - Path to migration file
   * @returns {Promise<{valid: boolean, errors: Array, warnings: Array}>}
   */
  async validateFile(filePath) {
    const content = await fs.readFile(filePath, 'utf-8');
    return this.validateContent(content, filePath);
  }

  /**
   * Extract function body from migration content
   * @param {string} content - Migration file content
   * @param {string} functionName - Function name (up or down)
   * @returns {string} Function body
   */
  extractFunctionBody(content, functionName) {
    // Match both 'export const up = async' and 'async up' formats
    const patterns = [
      new RegExp(`export\\s+const\\s+${functionName}\\s*=\\s*async\\s*\\([^)]*\\)\\s*=>\\s*{([\\s\\S]*?)}\\s*;?`, 'm'),
      new RegExp(`async\\s+${functionName}\\s*\\([^)]*\\)\\s*{([\\s\\S]*?)}`, 'm'),
    ];
    
    for (const regex of patterns) {
      const match = content.match(regex);
      if (match) {
        return match[1];
      }
    }
    
    return '';
  }

  /**
   * Validate migration content
   * @param {string} content - Migration file content
   * @param {string} fileName - File name for error reporting
   * @returns {{valid: boolean, errors: Array, warnings: Array}}
   */
  validateContent(content, fileName = 'unknown') {
    const errors = [];
    const warnings = [];

    // Extract up() and down() function bodies
    const upBody = this.extractFunctionBody(content, 'up');
    const downBody = this.extractFunctionBody(content, 'down');

    // Check if up() creates collections - if so, allow drop in down()
    const hasCreateCollection = this.containsOperation(upBody, 'createCollection');

    // Check for ignore comments
    // Format: // migrate-ignore: operation1, operation2
    const ignoreRules = [];
    const ignoreMatch = content.match(/\/\/\s*migrate-ignore:\s*([a-zA-Z0-9_, \t]+)/);
    if (ignoreMatch) {
      ignoreRules.push(...ignoreMatch[1].split(',').map(s => s.trim()));
    }

    // Check for forbidden database operations
    for (const operation of this.rules.forbidden.database) {
      if (ignoreRules.includes(operation)) {
        warnings.push({
          type: 'ignored-forbidden-operation',
          operation,
          message: `[IGNORED] Forbidden database operation: ${operation}`,
          file: fileName,
        });
        continue;
      }

      if (this.containsOperation(content, operation)) {
        if (this.options.allowDangerous) {
          warnings.push({
            type: 'allowed-dangerous-operation',
            operation,
            message: `[ALLOWED] Forbidden database operation: ${operation}`,
            file: fileName,
          });
        } else {
          errors.push({
            type: 'forbidden-database-operation',
            operation,
            message: `Forbidden database operation: ${operation}`,
            file: fileName,
          });
        }
      }
    }

    // Check for forbidden collection operations
    for (const operation of this.rules.forbidden.collections) {
      if (ignoreRules.includes(operation)) {
        warnings.push({
          type: 'ignored-forbidden-operation',
          operation,
          message: `[IGNORED] Forbidden collection operation: ${operation}`,
          file: fileName,
        });
        continue;
      }

      // Special case: Allow 'drop' or 'dropCollection' in down() if up() has createCollection
      if ((operation === 'drop' || operation === 'dropCollection') && hasCreateCollection) {
        const hasDropInDown = this.containsOperation(downBody, operation);
        if (hasDropInDown && !this.containsOperation(upBody, operation)) {
          warnings.push({
            type: 'allowed-drop-for-create',
            operation,
            message: `[ALLOWED] ${operation} in down() because up() creates collection`,
            file: fileName,
          });
          continue; // Skip the forbidden check for this operation
        }
      }

      if (this.containsOperation(content, operation)) {
        if (this.options.allowDangerous) {
          warnings.push({
            type: 'allowed-dangerous-operation',
            operation,
            message: `[ALLOWED] Forbidden collection operation: ${operation}`,
            file: fileName,
          });
        } else {
          errors.push({
            type: 'forbidden-collection-operation',
            operation,
            message: `Forbidden collection operation: ${operation}`,
            file: fileName,
          });
        }
      }
    }

    // Check for forbidden system operations
    for (const operation of this.rules.forbidden.system) {
      if (ignoreRules.includes(operation)) {
        warnings.push({
          type: 'ignored-forbidden-operation',
          operation,
          message: `[IGNORED] Forbidden system operation: ${operation}`,
          file: fileName,
        });
        continue;
      }

      if (this.containsOperation(content, operation)) {
        if (this.options.allowDangerous) {
          warnings.push({
            type: 'allowed-dangerous-operation',
            operation,
            message: `[ALLOWED] Forbidden system operation: ${operation}`,
            file: fileName,
          });
        } else {
          errors.push({
            type: 'forbidden-system-operation',
            operation,
            message: `Forbidden system operation: ${operation}`,
            file: fileName,
          });
        }
      }
    }

    // Check for forbidden admin operations
    for (const operation of this.rules.forbidden.admin) {
      if (ignoreRules.includes(operation)) {
        warnings.push({
          type: 'ignored-forbidden-operation',
          operation,
          message: `[IGNORED] Forbidden admin operation: ${operation}`,
          file: fileName,
        });
        continue;
      }

      if (this.containsOperation(content, operation)) {
        if (this.options.allowDangerous) {
          warnings.push({
            type: 'allowed-dangerous-operation',
            operation,
            message: `[ALLOWED] Forbidden admin operation: ${operation}`,
            file: fileName,
          });
        } else {
          errors.push({
            type: 'forbidden-admin-operation',
            operation,
            message: `Forbidden admin operation: ${operation}`,
            file: fileName,
          });
        }
      }
    }

    // Run custom validation rules
    if (this.rules.custom && Array.isArray(this.rules.custom)) {
      for (const customRule of this.rules.custom) {
        try {
          // Support both validate() and check() methods
          let isValid = true;
          if (typeof customRule.validate === 'function') {
            const result = customRule.validate(content);
            isValid = result.valid !== false;
            if (!isValid) {
              errors.push({
                type: 'custom-rule-violation',
                rule: customRule.name,
                message: result.error || customRule.message,
                file: fileName,
              });
            }
          } else if (typeof customRule.check === 'function') {
            isValid = customRule.check(content);
            if (!isValid) {
              errors.push({
                type: 'custom-rule-violation',
                rule: customRule.name,
                message: customRule.message || `Failed custom rule: ${customRule.name}`,
                file: fileName,
              });
            }
          }
        } catch (error) {
          errors.push({
            type: 'custom-rule-error',
            rule: customRule.name,
            message: `Error executing custom rule: ${error.message}`,
            file: fileName,
          });
        }
      }
    }

    // Check for warning-level operations
    if (this.rules.warnings && Array.isArray(this.rules.warnings.operations)) {
      for (const operation of this.rules.warnings.operations) {
        if (this.containsOperation(content, operation)) {
          warnings.push({
            type: 'warning-operation',
            operation,
            message: `Warning: ${operation} can affect large amounts of data. Please review carefully.`,
            file: fileName,
          });
        }
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    };
  }

  /**
   * Validate all migration files in a directory
   * @param {string} migrationsDir - Path to migrations directory
   * @returns {Promise<{valid: boolean, results: Array}>}
   */
  async validateDirectory(migrationsDir) {
    const files = await fs.readdir(migrationsDir);
    const migrationFiles = files.filter(f => f.endsWith('.js') && !f.includes('sample-migration'));

    const results = [];
    let allValid = true;

    for (const file of migrationFiles) {
      const filePath = path.join(migrationsDir, file);
      const result = await this.validateFile(filePath);
      
      results.push({
        file,
        ...result,
      });

      if (!result.valid) {
        allValid = false;
      }
    }

    return {
      valid: allValid,
      results,
    };
  }

  /**
   * Check if content contains a specific operation
   * @param {string} content - File content
   * @param {string} operation - Operation to check for
   * @returns {boolean}
   */
  containsOperation(content, operation) {
    // Create regex patterns for different operation styles
    const patterns = [
      new RegExp(`\\.${operation}\\s*\\(`),           // .operation(
      new RegExp(`db\\.${operation}\\s*\\(`),         // db.operation(
      new RegExp(`collection\\.${operation}\\s*\\(`), // collection.operation(
      new RegExp(`['"]${operation}['"]`),             // 'operation' or "operation"
    ];

    return patterns.some(pattern => pattern.test(content));
  }

  /**
   * Update validation rules
   * @param {Object} newRules - New rules to merge
   */
  updateRules(newRules) {
    this.rules = {
      ...this.rules,
      ...newRules,
      forbidden: {
        ...this.rules.forbidden,
        ...(newRules.forbidden || {}),
      },
      allowed: {
        ...this.rules.allowed,
        ...(newRules.allowed || {}),
      },
      custom: [
        ...(this.rules.custom || []),
        ...(newRules.custom || []),
      ],
      warnings: {
        ...this.rules.warnings,
        ...(newRules.warnings || {}),
        operations: [
            ...(this.rules.warnings?.operations || []),
            ...(newRules.warnings?.operations || [])
        ]
      }
    };
  }
}

export default MQLValidator;
