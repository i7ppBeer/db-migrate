const socket = io();
let currentProject = null;

// DOM Elements
const terminalOutput = document.getElementById('terminal-output');
const connectionStatus = document.getElementById('connection-status');
const projectList = document.getElementById('project-list');
const currentProjectDisplay = document.getElementById('current-project-display');
const migrationDescInput = document.getElementById('migration-desc');
const recentMigrationsList = document.getElementById('recent-migrations');
const commitMsgInput = document.getElementById('commit-msg');

// Socket Events
socket.on('connect', () => {
    connectionStatus.textContent = 'Connected';
    connectionStatus.className = 'status connected';
    loadConfig();
    loadProjects();
});

socket.on('disconnect', () => {
    connectionStatus.textContent = 'Disconnected';
    connectionStatus.className = 'status disconnected';
});

socket.on('output', (data) => {
    terminalOutput.textContent += data;
    terminalOutput.scrollTop = terminalOutput.scrollHeight;
});

socket.on('command-finished', ({ code, command }) => {
    terminalOutput.textContent += `\n[Process exited with code ${code}]\n`;
    terminalOutput.scrollTop = terminalOutput.scrollHeight;
    
    if (code === 0) {
        // Auto-refresh data if needed
        if (command.includes('create')) {
            loadRecentMigrations();
            activateStep(3); // Auto move to Edit step
        }
    }
});

// Navigation
function activateStep(stepNum) {
    // Update tabs
    document.querySelectorAll('.step').forEach(el => {
        el.classList.remove('active');
        if (parseInt(el.dataset.step) === stepNum) el.classList.add('active');
    });

    // Update views
    document.querySelectorAll('.view').forEach(el => {
        el.classList.remove('active');
    });
    document.getElementById(`view-${stepNum}`).classList.add('active');

    // Step specific actions
    if (stepNum === 2 && currentProject) {
        currentProjectDisplay.textContent = currentProject;
    }
    if (stepNum === 3 && currentProject) {
        loadRecentMigrations();
    }
}

function nextStep() {
    const current = document.querySelector('.step.active');
    const next = parseInt(current.dataset.step) + 1;
    if (next <= 6) activateStep(next);
}

// Actions
async function loadConfig() {
    try {
        const res = await fetch('/api/config');
        const config = await res.json();
        const pathEl = document.getElementById('projects-source-path');
        if (pathEl) pathEl.textContent = config.projectsDir;
    } catch (err) {
        console.error(err);
    }
}

async function loadProjects() {
    try {
        const res = await fetch('/api/projects');
        const projects = await res.json();
        projectList.innerHTML = '';
        
        if (projects.length === 0) {
            projectList.innerHTML = '<p>No projects found in the configured directory.</p>';
            return;
        }

        projects.forEach(p => {
            const div = document.createElement('div');
            div.className = 'project-card';
            div.textContent = p;
            div.onclick = () => selectProject(p, div);
            projectList.appendChild(div);
        });
    } catch (err) {
        console.error(err);
    }
}

function selectProject(name, element) {
    currentProject = name;
    document.querySelectorAll('.project-card').forEach(el => el.classList.remove('selected'));
    element.classList.add('selected');
    activateStep(2);
}

function createMigration() {
    const desc = migrationDescInput.value.trim();
    if (!currentProject) return alert('Please select a project first');
    if (!desc) return alert('Please enter a description');

    fetch('/api/config').then(res => res.json()).then(config => {
        const configPath = `${config.projectsDir}/${currentProject}/config.js`;
        runCommand('node', ['src/cli.js', 'create', desc, '-c', configPath]);
    });
}

    const configPath = `projects/${currentProject}/config.js`;
    runCommand('node', ['src/cli.js', 'create', desc, '-c', configPath]);
}

async function loadRecentMigrations() {
    if (!currentProject) return;
    try {
        const res = await fetch(`/api/migrations/${currentProject}`);
        const files = await res.json();
        recentMigrationsList.innerHTML = '';
        if (files.length === 0) {
            recentMigrationsList.innerHTML = '<p>No migrations found.</p>';
            return;
        }
        files.forEach(f => {
            const div = document.createElement('div');
            div.className = 'file-item';
            div.textContent = f;
            recentMigrationsList.appendChild(div);
        });
    } catch (err) {
        console.error(err);
    }
}

function runValidate() {
    runCommand('npm', ['run', 'validate']);
}

function runDockerTest() {
    runCommand('bash', ['scripts/docker-test.sh']);
}

function runLocalUp() {
    if (!currentProject) return alert('Select a project');
    fetch('/api/config').then(res => res.json()).then(config => {
        const configPath = `${config.projectsDir}/${currentProject}/config.js`;
        runCommand('node', ['src/cli.js', 'up', '-c', configPath, '--dry-run']);
    });
}

function gitStatus() {
    runCommand('git', ['status']);
}

function gitCommit() {
    const msg = commitMsgInput.value.trim();
    if (!msg) return alert('Enter commit message');
    
    // Chain commands: add -> commit -> push
    // Since we can't easily chain in one spawn call without shell script, 
    // we'll just run a shell command
    runCommand('bash', ['-c', `git add . && git commit -m "${msg}" && git push`]);
}

function runCommand(command, args) {
    socket.emit('run-command', { command, args });
}

function clearTerminal() {
    terminalOutput.textContent = '';
}
