import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';
import fs from 'fs/promises';
import { spawn } from 'child_process';
import open from 'open';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const toolRootDir = resolve(__dirname, '..');

// Configuration: Projects Directory
// Default to a sibling directory or environment variable
const PROJECTS_DIR = process.env.PROJECTS_DIR || resolve(toolRootDir, '../my-migration-projects/projects');

console.log(`Tool Root: ${toolRootDir}`);
console.log(`Projects Dir: ${PROJECTS_DIR}`);

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
    const projects = entries
      .filter(dirent => dirent.isDirectory())
      .map(dirent => dirent.name);
    res.json(projects);
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
