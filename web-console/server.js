import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';
import fs from 'fs/promises';
import { spawn } from 'child_process';
import open from 'open';

import { MQLValidator } from '../src/validators/mql-validator.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const toolRootDir = resolve(__dirname, '..');

// Configuration: Projects Directory
// Default to 'databases' directory in the tool root
const PROJECTS_DIR = process.env.PROJECTS_DIR || resolve(toolRootDir, 'databases');

console.log(`Tool Root: ${toolRootDir}`);
console.log(`Databases Dir: ${PROJECTS_DIR}`);

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);

app.use(express.static(join(__dirname, 'public')));
app.use(express.json());

// API to get config
app.get('/api/config', (req, res) => {
  res.json({
    projectsDir: PROJECTS_DIR,
    toolRootDir: toolRootDir
  });
});

// API to create a new database project
app.post('/api/databases', async (req, res) => {
  try {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: 'Database name is required' });
    
    // Validate name (alphanumeric only)
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
      return res.status(400).json({ error: 'Invalid database name. Use alphanumeric, underscore or hyphen.' });
    }

    const dbDir = join(PROJECTS_DIR, name);
    const migrationsDir = join(dbDir, 'migrations');
    
    // Check if exists
    try {
      await fs.access(dbDir);
      return res.status(400).json({ error: 'Database already exists' });
    } catch (e) {
      // Doesn't exist, proceed
    }

    // Create directories
    await fs.mkdir(migrationsDir, { recursive: true });

    // Create config.js
    const configContent = `export default {
  mongodb: {
    // TODO Change (or review) the url to your MongoDB:
    url: process.env.${name.toUpperCase()}_DB_URL || process.env.MONGODB_URL || "mongodb://localhost:27017",

    // TODO Change this to your database name:
    databaseName: process.env.${name.toUpperCase()}_DB_NAME || "${name}_db",

    options: {
      // useNewUrlParser: true, // removes a deprecation warning when connecting (not needed in mongodb driver 4.x+)
      // useUnifiedTopology: true, // removes a deprecating warning when connecting (not needed in mongodb driver 4.x+)
      //   connectTimeoutMS: 3600000, // increase connection timeout to 1 hour
      //   socketTimeoutMS: 3600000, // increase socket timeout to 1 hour
    }
  },

  // The migrations dir, can be an relative or absolute path. Only edit this when really necessary.
  migrationsDir: "migrations",

  // The mongodb collection where the applied changes are stored. Only edit this when really necessary.
  changelogCollectionName: "changelog",

  // The mongodb collection where the lock will be created.
  lockCollectionName: "changelog_lock",

  // The value in seconds for the TTL index that will be used for the lock. Value of 0 will disable the feature.
  lockTtl: 0,

  // The file extension to create migrations and search for in migration dir 
  migrationFileExtension: ".js",

  // Enable the algorithm to create a checksum of the file contents and use that in the comparison to determine
  // if the file should be run.  Requires that scripts are coded to be run multiple times.
  useFileHash: false,

  // Don't change this, unless you know what you're doing
  moduleSystem: 'esm',

  // Validation rules
  validation: {
    forbidden: {
      database: ['dropDatabase', 'createUser', 'dropUser', 'updateUser', 'grantRolesToUser', 'revokeRolesFromUser', 'createRole', 'dropRole', 'updateRole', 'repairDatabase', 'cloneDatabase', 'copyDatabase'],
      collections: ['drop', 'reIndex'],
      system: ['shutdown', 'killOp', 'killAllSessions', 'serverStatus', 'replSetGetStatus', 'isMaster'],
      admin: ['enableSharding', 'shardCollection', 'movePrimary', 'removeShard']
    }
  }
};
`;
    await fs.writeFile(join(dbDir, 'config.js'), configContent);

    res.json({ success: true, name, path: dbDir });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// API to read a file
app.get('/api/file', async (req, res) => {
  try {
    const { path: filePath } = req.query;
    if (!filePath) return res.status(400).json({ error: 'Path is required' });
    
    const content = await fs.readFile(filePath, 'utf-8');
    res.json({ content });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// API to write a file
app.post('/api/file', async (req, res) => {
  try {
    const { path: filePath, content } = req.body;
    if (!filePath || content === undefined) return res.status(400).json({ error: 'Path and content are required' });
    
    await fs.writeFile(filePath, content, 'utf-8');
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// API to delete a file
app.delete('/api/file', async (req, res) => {
  try {
    const filePath = (req.body && req.body.path) || (req.query && req.query.path);
    console.log(`[DELETE] Attempting to delete: ${filePath}`);
    
    if (!filePath) return res.status(400).json({ error: 'Path is required' });
    
    await fs.unlink(filePath);
    console.log(`[DELETE] Successfully deleted: ${filePath}`);
    res.json({ success: true });
  } catch (error) {
    console.error(`[DELETE] Error: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// API to get projects
app.get('/api/projects', async (req, res) => {
  try {
    // Check if projects dir exists
    try {
      await fs.access(PROJECTS_DIR);
    } catch {
      return res.json([]); // Return empty if dir doesn't exist
    }

    const entries = await fs.readdir(PROJECTS_DIR, { withFileTypes: true });
    
    // Get projects with their migration counts
    const projects = await Promise.all(
      entries
        .filter(dirent => dirent.isDirectory())
        .map(async dirent => {
          const name = dirent.name;
          const migrationsDir = join(PROJECTS_DIR, name, 'migrations');
          let migrationCount = 0;
          let lastMigration = null;
          
          try {
            const files = await fs.readdir(migrationsDir);
            const migrationFiles = files.filter(f => f.endsWith('.js')).sort().reverse();
            migrationCount = migrationFiles.length;
            lastMigration = migrationFiles.length > 0 ? migrationFiles[0] : null;
          } catch (e) {
            // ignore
          }

          return {
            name,
            migrationCount,
            lastMigration
          };
        })
    );
    
    res.json(projects);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// API to list directories for the file browser
app.get('/api/fs/list', async (req, res) => {
  try {
    const dirPath = req.query.path || process.env.HOME || '/';
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    
    const directories = entries
      .filter(dirent => dirent.isDirectory())
      .map(dirent => dirent.name)
      .filter(name => !name.startsWith('.')) // Hide hidden folders
      .sort();

    const files = entries
      .filter(dirent => dirent.isFile())
      .map(dirent => dirent.name)
      .filter(name => !name.startsWith('.'))
      .sort();

    res.json({
      currentPath: resolve(dirPath),
      parentPath: resolve(dirPath, '..'),
      directories,
      files
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// API to get recent migrations for a project
app.get('/api/migrations/:project', async (req, res) => {
  try {
    const { project } = req.params;
    const migrationsDir = join(PROJECTS_DIR, project, 'migrations');
    try {
      const files = await fs.readdir(migrationsDir);
      const recent = files
        .filter(f => f.endsWith('.js'))
        .sort()
        .reverse()
        .slice(0, 5);
      res.json(recent);
    } catch (e) {
      res.json([]);
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// API to get migrations from a specific path
app.post('/api/migrations/list', async (req, res) => {
  try {
    const { projectPath } = req.body;
    if (!projectPath) return res.status(400).json({ error: 'projectPath is required' });

    const migrationsDir = join(projectPath, 'migrations');
    try {
      const files = await fs.readdir(migrationsDir);
      const recent = files
        .filter(f => f.endsWith('.js'))
        .sort()
        .reverse()
        .slice(0, 5);
      res.json(recent);
    } catch (e) {
      // If migrations dir doesn't exist, return empty
      res.json([]);
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// API to get validation rules for a project
app.get('/api/validation-rules', async (req, res) => {
  try {
    const { projectPath } = req.query;
    let config = {};
    
    if (projectPath) {
      const configPath = join(projectPath, 'config.js');
      try {
        await fs.access(configPath);
        // Dynamically import the config
        const configModule = await import(`file://${configPath}`);
        config = configModule.default;
      } catch (e) {
        console.warn(`Could not load config from ${configPath}, using defaults.`);
      }
    }

    // Use MQLValidator to merge defaults with project config
    const validator = new MQLValidator(config.validation || null);
    
    res.json({
      forbidden: validator.rules.forbidden,
      warnings: validator.rules.warnings
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// API to get default validation rules
app.get('/api/default-validation-rules', (req, res) => {
  try {
    import('../src/config/validation-rules.js').then(module => {
      res.json(module.validationRules);
    }).catch(err => {
      res.status(500).json({ error: err.message });
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

io.on('connection', (socket) => {
  console.log('Client connected');

  socket.on('run-command', ({ command, args, cwd }) => {
    const cmdString = `${command} ${args.join(' ')}`;
    socket.emit('output', `\n> ${cmdString}\n`);

    const proc = spawn(command, args, {
      cwd: cwd || toolRootDir, // Always run from tool root to find src/cli.js
      shell: true,
      env: { ...process.env, FORCE_COLOR: 'true' }
    });

    proc.stdout.on('data', (data) => {
      socket.emit('output', data.toString());
    });

    proc.stderr.on('data', (data) => {
      socket.emit('output', data.toString());
    });

    proc.on('close', (code) => {
      socket.emit('command-finished', { code, command: cmdString });
    });
  });
});

const PORT = 3000;
httpServer.listen(PORT, () => {
  console.log(`Web Console running at http://localhost:${PORT}`);
  // open(`http://localhost:${PORT}`);
});
