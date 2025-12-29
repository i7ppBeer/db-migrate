#!/usr/bin/env node

/**
 * MongoDB Migration CLI
 * Command-line interface for managing MongoDB migrations
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { MQLValidator } from './validators/mql-validator.js';
import { MigrationTester } from './testers/migration-tester.js';
import migrateMongo from 'migrate-mongo';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const program = new Command();

// Global option for config file
program
  .name('mongodb-migrate-ddl')
  .description('MongoDB DDL migration management with validation and testing')
  .version('1.0.0')
  .option('-c, --config <path>', 'Path to config file (default: migrate-mongo-config.js)', 'migrate-mongo-config.js');

// Initialize migration project
program
  .command('init')
  .description('Initialize a new migration project')
  .option('-m, --module <system>', 'Module system (esm or commonjs)', 'esm')
  .action(async (options) => {
    try {
      console.log(chalk.blue('[INIT] Initializing migration project...'));
      
      global.options = options;
      await migrateMongo.init();
      
      // Create additional directories
      await fs.mkdir('scripts', { recursive: true });
      await fs.mkdir('k8s', { recursive: true });
      await fs.mkdir('k8s/secrets', { recursive: true });
      await fs.mkdir('.github/workflows', { recursive: true });
      
      console.log(chalk.green('[OK] Initialization successful!'));
      console.log(chalk.yellow('\nNext steps:'));
      console.log('1. Edit migrate-mongo-config.js with your MongoDB settings');
      console.log('2. Update src/config/validation-rules.js if needed');
      console.log('3. Create your first migration: npm run create <description>');
    } catch (error) {
      console.error(chalk.red('[ERROR] Error:'), error.message);
      process.exit(1);
    }
  });

/**
 * Load and apply custom config file
 */
async function loadConfig(configPath) {
  try {
    const absolutePath = path.isAbsolute(configPath) 
      ? configPath 
      : path.resolve(process.cwd(), configPath);
    
    // Check if file exists
    await fs.access(absolutePath);
    
    console.log(chalk.gray(`[CONFIG] Using config: ${configPath}`));
    
    // Dynamically import the config
    const configModule = await import(`file://${absolutePath}`);
    const customConfig = configModule.default;
    
    // Resolve migrationsDir relative to config file
    if (customConfig.migrationsDir) {
      const configDir = path.dirname(absolutePath);
      // If it's not absolute, make it absolute relative to the config file
      if (!path.isAbsolute(customConfig.migrationsDir)) {
        customConfig.migrationsDir = path.resolve(configDir, customConfig.migrationsDir);
      }
    }

    // Set config for migrate-mongo
    if (migrateMongo.config.set) {
      migrateMongo.config.set(customConfig);
    } else {
      // Fallback or warning if needed, but v14 should have it
      console.warn(chalk.yellow('[WARN] migrate-mongo version might not support config.set'));
    }
    
    // Override environment variables based on config
    if (customConfig.mongodb.url) {
      process.env.MONGODB_URL = customConfig.mongodb.url;
    }
    if (customConfig.mongodb.databaseName) {
      process.env.MONGODB_DATABASE = customConfig.mongodb.databaseName;
    }
    if (customConfig.migrationsDir) {
      process.env.MIGRATIONS_DIR = customConfig.migrationsDir;
    }
    
    return customConfig;
  } catch (error) {
    console.error(chalk.red(`[ERROR] Config file not found: ${configPath}`));
    console.log(chalk.yellow('\nAvailable project configs:'));
    try {
      const projectsDir = path.resolve(process.cwd(), 'projects');
      const projects = await fs.readdir(projectsDir);
      for (const project of projects) {
        const projectConfig = path.join(projectsDir, project, 'config.js');
        try {
          await fs.access(projectConfig);
          console.log(chalk.gray(`  - projects/${project}/config.js`));
        } catch (e) {
          // config.js doesn't exist in this project folder
        }
      }
    } catch (e) {
      // projects directory doesn't exist
    }
    process.exit(1);
  }
}

// Create new migration
program
  .command('create <description>')
  .description('Create a new migration file')
  .action(async (description, options, command) => {
    try {
      const configPath = command.parent.opts().config;
      await loadConfig(configPath);
      
      console.log(chalk.blue(`[CREATE] Creating migration: ${description}...`));
      
      const fileName = await migrateMongo.create(description);
      const config = await migrateMongo.config.read();
      
      console.log(chalk.green(`[OK] Created: ${config.migrationsDir}/${fileName}`));
      console.log(chalk.yellow('\nRemember to:'));
      console.log('1. Implement the up() and down() functions');
      console.log('2. Run validation: npm run validate');
      console.log('3. Test locally: npm run test:local');
    } catch (error) {
      console.error(chalk.red('[ERROR] Error:'), error.message);
      process.exit(1);
    }
  });

// Validate migrations
program
  .command('validate')
  .description('Validate all migration files')
  .option('-f, --file <file>', 'Validate specific file')
  .option('--allow-dangerous', 'Allow dangerous operations (treat errors as warnings)')
  .action(async (options, command) => {
    try {
      const configPath = command.parent.opts().config;
      await loadConfig(configPath);
      
      console.log(chalk.blue('[INFO] Validating migrations...\n'));
      
      const validator = new MQLValidator(null, { allowDangerous: options.allowDangerous });
      const config = await migrateMongo.config.read();
      
      let result;
      if (options.file) {
        result = await validator.validateFile(options.file);
        result = { valid: result.valid, results: [{ file: options.file, ...result }] };
      } else {
        result = await validator.validateDirectory(config.migrationsDir);
      }
      
      // Display results
      for (const fileResult of result.results) {
        if (fileResult.valid) {
          console.log(chalk.green(`[OK] ${fileResult.file}`));
        } else {
          console.log(chalk.red(`[ERROR] ${fileResult.file}`));
        }
        
        // Show errors
        if (fileResult.errors && fileResult.errors.length > 0) {
          for (const error of fileResult.errors) {
            console.log(chalk.red(`   [ERROR] ${error.message}`));
          }
        }
        
        // Show warnings
        if (fileResult.warnings && fileResult.warnings.length > 0) {
          for (const warning of fileResult.warnings) {
            console.log(chalk.yellow(`   [WARN]  ${warning.message}`));
          }
        }
        
        console.log('');
      }
      
      // Summary
      const totalFiles = result.results.length;
      const validFiles = result.results.filter(r => r.valid).length;
      const invalidFiles = totalFiles - validFiles;
      
      console.log(chalk.bold('\n[SUMMARY] Summary:'));
      console.log(`   Total files: ${totalFiles}`);
      console.log(chalk.green(`   Valid: ${validFiles}`));
      if (invalidFiles > 0) {
        console.log(chalk.red(`   Invalid: ${invalidFiles}`));
      }
      
      if (!result.valid) {
        console.log(chalk.red('\n[ERROR] Validation failed!'));
        process.exit(1);
      } else {
        console.log(chalk.green('\n[OK] All validations passed!'));
      }
    } catch (error) {
      console.error(chalk.red('[ERROR] Error:'), error.message);
      process.exit(1);
    }
  });

// Test migrations locally
program
  .command('test-local')
  .description('Test migrations in local Docker container')
  .option('--min-version <version>', 'Minimum MongoDB version', '6.0')
  .option('--max-version <version>', 'Maximum MongoDB version', '8.0')
  .action(async (options, command) => {
    try {
      const configPath = command.parent.opts().config;
      await loadConfig(configPath);
      
      console.log(chalk.blue('[TEST] Testing migrations locally...\n'));
      
      const tester = new MigrationTester({
        minVersion: options.minVersion,
        maxVersion: options.maxVersion,
      });
      
      await tester.runFullTest();
      
      console.log(chalk.green('\n[OK] All tests passed!'));
    } catch (error) {
      console.error(chalk.red('\n[ERROR] Test failed:'), error.message);
      process.exit(1);
    }
  });

// Run migrations (up)
program
  .command('up')
  .description('Run all pending migrations')
  .option('--dry-run', 'Show what would be migrated without executing')
  .action(async (options, command) => {
    try {
      const configPath = command.parent.opts().config;
      await loadConfig(configPath);
      
      if (options.dryRun) {
        console.log(chalk.blue('[INFO] Dry run - checking pending migrations...\n'));
        const { db, client } = await migrateMongo.database.connect();
        const status = await migrateMongo.status(db);
        const pending = status.filter(s => s.appliedAt === 'PENDING');
        
        if (pending.length === 0) {
          console.log(chalk.green('[OK] No pending migrations'));
        } else {
          console.log(chalk.yellow(`[LIST] ${pending.length} pending migration(s):`));
          pending.forEach(m => console.log(`   - ${m.fileName}`));
        }
        
        await client.close();
      } else {
        console.log(chalk.blue('[UP]  Running migrations...\n'));
        
        const { db, client } = await migrateMongo.database.connect();
        const migrated = await migrateMongo.up(db, client);
        
        if (migrated.length === 0) {
          console.log(chalk.green('[OK] No migrations to apply'));
        } else {
          migrated.forEach(fileName => {
            console.log(chalk.green(`[OK] MIGRATED UP: ${fileName}`));
          });
        }
        
        await client.close();
        console.log(chalk.green('\n[OK] Migration completed successfully!'));
      }
    } catch (error) {
      console.error(chalk.red('[ERROR] Migration failed:'), error.message);
      if (error.migrated && error.migrated.length > 0) {
        console.log(chalk.yellow('\n[WARN]  Partially migrated:'));
        error.migrated.forEach(f => console.log(`   - ${f}`));
      }
      process.exit(1);
    }
  });

// Rollback migrations (down)
program
  .command('down')
  .description('Rollback the last applied migration')
  .option('-b, --block', 'Rollback all migrations from the same block')
  .action(async (options, command) => {
    try {
      const configPath = command.parent.opts().config;
      await loadConfig(configPath);
      
      global.options = options;
      console.log(chalk.blue('[DOWN]  Rolling back migration...\n'));
      
      const { db, client } = await migrateMongo.database.connect();
      const migrated = await migrateMongo.down(db, client);
      
      if (migrated.length === 0) {
        console.log(chalk.yellow('[WARN]  No migrations to rollback'));
      } else {
        migrated.forEach(fileName => {
          console.log(chalk.green(`[OK] MIGRATED DOWN: ${fileName}`));
        });
      }
      
      await client.close();
      console.log(chalk.green('\n[OK] Rollback completed successfully!'));
    } catch (error) {
      console.error(chalk.red('[ERROR] Rollback failed:'), error.message);
      process.exit(1);
    }
  });

// Check migration status
program
  .command('status')
  .description('Show migration status')
  .action(async (options, command) => {
    try {
      const configPath = command.parent.opts().config;
      await loadConfig(configPath);
      
      console.log(chalk.blue('[SUMMARY] Checking migration status...\n'));
      
      const { db, client } = await migrateMongo.database.connect();
      const statusItems = await migrateMongo.status(db);
      
      console.log('+-----------------------------------------+------------------------+');
      console.log('| Filename                                | Applied At             |');
      console.log('+-----------------------------------------+------------------------+');
      
      statusItems.forEach(item => {
        const fileName = item.fileName.padEnd(39);
        const appliedAt = item.appliedAt === 'PENDING' 
          ? chalk.yellow('PENDING'.padEnd(22))
          : item.appliedAt.padEnd(22);
        console.log(`| ${fileName} | ${appliedAt} |`);
      });
      
      console.log('+-----------------------------------------+------------------------+');
      
      await client.close();
    } catch (error) {
      console.error(chalk.red('[ERROR] Error:'), error.message);
      process.exit(1);
    }
  });

program.parse(process.argv);

if (!process.argv.slice(2).length) {
  program.outputHelp();
}
