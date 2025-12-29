const socket = io();
let currentProject = null;
let currentProjectPath = null;
// let projectsDir = null; // Store this globally - Removed
let currentEditingFile = null; // Track currently edited file
let editor = null; // CodeMirror instance

// Initialize CodeMirror
document.addEventListener('DOMContentLoaded', () => {
    const textarea = document.getElementById('code-editor');
    if (textarea) {
        editor = CodeMirror.fromTextArea(textarea, {
            mode: 'javascript',
            theme: 'eclipse',
            lineNumbers: true,
            lineWrapping: true,
            indentUnit: 2,
            tabSize: 2
        });
        
        // Ensure editor resizes correctly
        editor.setSize('100%', '100%');
    }
});

// DOM Elements
const terminalOutput = document.getElementById('terminal-output');
const connectionStatus = document.getElementById('connection-status');
const projectList = document.getElementById('project-list');
const currentProjectDisplay = document.getElementById('current-project-display');
const migrationDescInput = document.getElementById('migration-desc');
const recentMigrationsList = document.getElementById('recent-migrations');
const commitMsgInput = document.getElementById('commit-msg');
const manualProjectInput = document.getElementById('manual-project-path');

// Simple ANSI to HTML converter
function ansiToHtml(text) {
    // Escape HTML
    text = text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");

    // Basic ANSI colors
    const colors = {
        30: 'black', 31: '#d32f2f', 32: '#388e3c', 33: '#fbc02d', 34: '#1976d2', 35: '#7b1fa2', 36: '#0097a7', 37: '#eeeeee',
        90: '#757575', 91: '#ff5252', 92: '#69f0ae', 93: '#ffff00', 94: '#40c4ff', 95: '#e040fb', 96: '#18ffff', 97: '#ffffff'
    };

    return text.replace(/\x1b\[(\d+)(?:;(\d+))?m/g, (match, p1, p2) => {
        const code = p1;
        if (code === '0' || code === '39') {
            return '</span>';
        }
        if (colors[code]) {
            return `<span style="color: ${colors[code]}">`;
        }
        // Bold
        if (code === '1') {
            return '<span style="font-weight: bold">';
        }
        return '';
    });
}

// Socket Events
socket.on('connect', () => {
    connectionStatus.textContent = 'Connected';
    connectionStatus.className = 'status connected';
});

socket.on('disconnect', () => {
    connectionStatus.textContent = 'Disconnected';
    connectionStatus.className = 'status disconnected';
});

socket.on('output', (data) => {
    const html = ansiToHtml(data);
    terminalOutput.insertAdjacentHTML('beforeend', html);
    terminalOutput.scrollTop = terminalOutput.scrollHeight;
});

socket.on('command-finished', ({ code, command }) => {
    terminalOutput.innerHTML += `\n[Process exited with code ${code}]\n`;
    terminalOutput.scrollTop = terminalOutput.scrollHeight;
    
    if (code === 0) {
        // Auto-refresh data if needed
        if (command.includes('create')) {
            refreshFileList();
            // Stay on step 2 to edit the new file
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
        refreshFileList();
    }
    if (stepNum === 3) {
        loadValidationList();
    }
}

function nextStep() {
    const current = document.querySelector('.step.active');
    const next = parseInt(current.dataset.step) + 1;
    if (next <= 6) activateStep(next);
}

// Actions
// loadConfig and loadProjects removed as we now use manual path selection only


function selectManualProject() {
    const path = manualProjectInput.value.trim();
    if (!path) return alert('Please enter a project path');
    
    // Extract name from path (simple version)
    const name = path.split('/').pop() || path;
    
    currentProject = name;
    currentProjectPath = path;
    
    document.querySelectorAll('.project-card').forEach(el => el.classList.remove('selected'));
    activateStep(2);
}

// File Browser Logic
let currentBrowserPath = '/';

function openFileBrowser() {
    document.getElementById('file-browser-modal').classList.add('open');
    // Start at current input value or root
    const currentInput = manualProjectInput.value.trim();
    loadDirectory(currentInput || '/');
}

function closeFileBrowser() {
    document.getElementById('file-browser-modal').classList.remove('open');
}

async function loadDirectory(path) {
    try {
        const res = await fetch(`/api/fs/list?path=${encodeURIComponent(path)}`);
        if (!res.ok) throw new Error('Failed to load directory');
        
        const data = await res.json();
        currentBrowserPath = data.currentPath;
        
        // Update breadcrumb
        document.getElementById('fb-current-path').textContent = data.currentPath;
        
        const listEl = document.getElementById('fb-list');
        listEl.innerHTML = '';

        // Add parent directory option if not root
        if (data.parentPath && data.parentPath !== data.currentPath) {
            const div = document.createElement('div');
            div.className = 'file-list-item';
            div.innerHTML = '<span class="icon dir-icon">📂</span> <strong>..</strong>';
            div.onclick = () => loadDirectory(data.parentPath);
            listEl.appendChild(div);
        }

        data.directories.forEach(dir => {
            const div = document.createElement('div');
            div.className = 'file-list-item';
            div.innerHTML = `<span class="icon dir-icon">📂</span> ${dir}`;
            div.onclick = () => loadDirectory(`${data.currentPath}/${dir}`);
            listEl.appendChild(div);
        });

        // Show files (optional, but helpful to see config files)
        if (data.files) {
            data.files.forEach(file => {
                const div = document.createElement('div');
                div.className = 'file-list-item';
                div.style.color = '#666';
                div.innerHTML = `<span class="icon file-icon">📄</span> ${file}`;
                // Clicking a file could select the directory it's in
                div.onclick = () => {
                    // Do nothing or maybe select the file? 
                    // For now, just let them see it exists.
                };
                listEl.appendChild(div);
            });
        }

    } catch (err) {
        console.error(err);
        // If path is invalid, try root
        if (path !== '/') loadDirectory('/');
    }
}

async function confirmFileSelection() {
    manualProjectInput.value = currentBrowserPath;
    const display = document.getElementById('selected-project-path');
    if (display) display.textContent = currentBrowserPath;
    closeFileBrowser();
    
    // Check if this directory is a project (has config or migrations)
    try {
        const res = await fetch(`/api/fs/list?path=${encodeURIComponent(currentBrowserPath)}`);
        const data = await res.json();
        
        const hasConfig = data.files && (data.files.includes('config.js') || data.files.includes('migrate-mongo-config.js'));
        const hasMigrations = data.directories && data.directories.includes('migrations');

        if (hasConfig || hasMigrations) {
            // It's likely a project, select it immediately
            const path = currentBrowserPath;
            const name = path.split('/').pop() || path;
            currentProject = name;
            currentProjectPath = path;
            activateStep(2);
            return;
        }

        const subProjectList = document.getElementById('sub-project-list');
        subProjectList.innerHTML = '';
        subProjectList.style.display = 'none';

        // If it has directories, list them as potential projects
        if (data.directories && data.directories.length > 0) {
            subProjectList.style.display = 'grid';
            
            data.directories.forEach(dir => {
                const div = document.createElement('div');
                div.className = 'project-card';
                div.innerHTML = `
                    <div style="font-weight: bold; font-size: 1.1em; margin-bottom: 5px;">${dir}</div>
                    <div style="font-size: 0.9em; color: #666;">
                        <div>Folder</div>
                    </div>
                `;
                div.onclick = () => {
                    // Select this sub-directory as the project
                    const fullPath = `${currentBrowserPath}/${dir}`;
                    currentProject = dir;
                    currentProjectPath = fullPath;
                    activateStep(2);
                };
                subProjectList.appendChild(div);
            });
        } else {
            // No sub-directories, assume this is the project
            const path = currentBrowserPath;
            const name = path.split('/').pop() || path;
            currentProject = name;
            currentProjectPath = path;
            activateStep(2);
        }
    } catch (e) {
        console.error(e);
        // Fallback
        const path = currentBrowserPath;
        const name = path.split('/').pop() || path;
        currentProject = name;
        currentProjectPath = path;
        activateStep(2);
    }
}

// Create Database Modal
function showCreateDbModal() {
    document.getElementById('create-db-modal').classList.add('open');
    document.getElementById('new-db-name').focus();
}

function closeCreateDbModal() {
    document.getElementById('create-db-modal').classList.remove('open');
    document.getElementById('new-db-name').value = '';
}

async function createNewDatabase() {
    const nameInput = document.getElementById('new-db-name');
    const name = nameInput.value.trim();
    
    if (!name) return alert('Please enter a database name');
    
    try {
        const res = await fetch('/api/databases', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name })
        });
        
        const data = await res.json();
        
        if (res.ok) {
            closeCreateDbModal();
            // loadProjects(); // Refresh list - Removed
            // Optionally auto-select
            // selectProject(name, ...);
        } else {
            alert(data.error || 'Failed to create database');
        }
    } catch (err) {
        console.error(err);
        alert('Error creating database');
    }
}

async function createMigration() {
    const desc = migrationDescInput.value.trim();
    if (!currentProjectPath) return alert('Please select a project first');
    if (!desc) return alert('Please enter a description');

    // Detect config file
    let configFileName = 'migrate-mongo-config.js'; // Default
    try {
        const res = await fetch(`/api/fs/list?path=${encodeURIComponent(currentProjectPath)}`);
        const data = await res.json();
        if (data.files) {
            if (data.files.includes('config.js')) {
                configFileName = 'config.js';
            } else if (data.files.includes('migrate-mongo-config.js')) {
                configFileName = 'migrate-mongo-config.js';
            }
        }
    } catch (e) {
        console.error('Error checking config file:', e);
    }

    const configPath = `${currentProjectPath}/${configFileName}`;
    // Wrap description in quotes to handle spaces
    runCommand('node', ['src/cli.js', 'create', `"${desc}"`, '-c', configPath]);
}

async function loadRecentMigrations() {
    if (!currentProjectPath) return;
    try {
        // Use the new POST API that accepts a path
        const res = await fetch('/api/migrations/list', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ projectPath: currentProjectPath })
        });
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

async function loadValidationList() {
    const container = document.getElementById('validate-list');
    container.innerHTML = '<div style="color: #666;">Loading projects...</div>';

    try {
        // Fetch projects from server
        const res = await fetch('/api/projects');
        const projects = await res.json();
        
        // Also consider current manual project if not in the list
        const allProjects = [...projects];
        
        // If we have a current project path that isn't in the scanned list (e.g. manual path)
        // We should add it. But checking if it's already there is tricky without full paths.
        // For simplicity, we'll just list what the server found + current if valid.
        
        container.innerHTML = '';
        
        if (allProjects.length === 0 && !currentProjectPath) {
            container.innerHTML = '<div>No projects found.</div>';
            return;
        }

        // Helper to add checkbox
        const addCheckbox = (name, path, checked = true) => {
            const div = document.createElement('div');
            div.style.marginBottom = '8px';
            div.style.display = 'flex';
            div.style.alignItems = 'center';
            
            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.id = `val-proj-${name}`;
            checkbox.value = path;
            checkbox.checked = checked;
            checkbox.style.marginRight = '10px';
            
            const label = document.createElement('label');
            label.htmlFor = `val-proj-${name}`;
            label.textContent = name;
            label.style.cursor = 'pointer';
            label.style.fontWeight = '500';
            
            div.appendChild(checkbox);
            div.appendChild(label);
            container.appendChild(div);
        };

        // Add scanned projects
        allProjects.forEach(p => {
            // Assuming standard structure: project path is databases/<name>
            // We need the full path. The API returns name.
            // We can fetch config to get root dir or assume standard.
            // Let's assume standard for now or fetch config.
            // Actually, let's just use the name and let the server resolve or pass full path if available.
            // The /api/projects returns { name, migrationCount... }
            // We need the path.
            // Let's assume they are in the default projects dir.
            // Wait, we need the absolute path for the CLI command.
            // We can construct it if we know PROJECTS_DIR, but client doesn't know it easily.
            // Let's fetch config first to get projectsDir? Or just use relative path 'databases/<name>'
            
            // Better: Use the API to get full path or just use relative 'databases/name'
            addCheckbox(p.name, `databases/${p.name}`);
        });

        // If current project is manual and not in the list (by name check approx)
        if (currentProjectPath && !allProjects.find(p => currentProjectPath.endsWith(p.name))) {
             const name = currentProjectPath.split('/').pop();
             addCheckbox(`${name} (Current)`, currentProjectPath);
        }
        
    } catch (err) {
        console.error(err);
        container.innerHTML = '<div style="color: red;">Error loading projects</div>';
    }
}

function runValidate() {
    const checkboxes = document.querySelectorAll('#validate-list input[type="checkbox"]:checked');
    if (checkboxes.length === 0) return alert('Please select at least one database to validate.');

    const allowDangerous = document.getElementById('allow-dangerous-check').checked;
    const flag = allowDangerous ? ' --allow-dangerous' : '';

    const commands = [];
    checkboxes.forEach(cb => {
        const configPath = `${cb.value}/config.js`;
        // Use 'node src/cli.js' directly
        commands.push(`echo "---------------------------------------------------"`);
        commands.push(`echo "Validating: ${cb.value}..."`);
        commands.push(`node src/cli.js validate -c "${configPath}"${flag}`);
    });

    // Join commands with ; to run all even if one fails, or && to stop on error.
    // User probably wants to see all results.
    const fullCommand = commands.join(' ; ');
    
    runCommand('bash', ['-c', fullCommand]);
}

function runDockerTest() {
    runCommand('bash', ['scripts/docker-test.sh']);
}

function runLocalUp() {
    if (!currentProjectPath) return alert('Select a project');
    const configPath = `${currentProjectPath}/config.js`;
    runCommand('node', ['src/cli.js', 'up', '-c', configPath, '--dry-run']);
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

// --- Editor & Management Logic ---

async function refreshFileList() {
    if (!currentProjectPath) return;
    
    const listContainer = document.getElementById('migration-list-container');
    listContainer.innerHTML = '<div style="padding:10px; color:#666;">Loading...</div>';

    try {
        // 1. Get Config File
        const fsRes = await fetch(`/api/fs/list?path=${encodeURIComponent(currentProjectPath)}`);
        const fsData = await fsRes.json();
        let configFile = 'migrate-mongo-config.js';
        if (fsData.files && fsData.files.includes('config.js')) configFile = 'config.js';

        // 2. Get Migrations
        const migRes = await fetch('/api/migrations/list', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ projectPath: currentProjectPath })
        });
        const migrations = await migRes.json();

        // Render
        listContainer.innerHTML = '';

        // Config Section
        const configDiv = document.createElement('div');
        configDiv.className = 'file-item';
        configDiv.innerHTML = `<span class="icon config-icon">⚙️</span> ${configFile}`;
        configDiv.onclick = () => loadConfigForEdit();
        listContainer.appendChild(configDiv);

        // Separator
        const sep = document.createElement('div');
        sep.style.borderBottom = '1px solid #eee';
        sep.style.margin = '5px 0';
        listContainer.appendChild(sep);

        // Migrations
        if (migrations.length === 0) {
            const empty = document.createElement('div');
            empty.style.padding = '10px';
            empty.style.color = '#999';
            empty.style.fontSize = '0.9em';
            empty.textContent = 'No migrations yet';
            listContainer.appendChild(empty);
        } else {
            migrations.forEach(mig => {
                const div = document.createElement('div');
                div.className = 'file-item';
                div.style.display = 'flex';
                div.style.justifyContent = 'space-between';
                div.style.alignItems = 'center';
                
                const span = document.createElement('span');
                span.innerHTML = `<span class="icon file-icon">📄</span> ${mig}`;
                span.style.cursor = 'pointer';
                span.style.flex = '1';
                span.onclick = () => loadMigrationForEdit(mig);
                
                const delBtn = document.createElement('button');
                delBtn.className = 'btn secondary small';
                delBtn.style.padding = '2px 6px';
                delBtn.style.marginLeft = '5px';
                delBtn.style.color = '#d32f2f';
                delBtn.style.borderColor = '#d32f2f';
                delBtn.innerHTML = '✕';
                delBtn.title = 'Delete Migration';
                delBtn.onclick = (e) => {
                    e.stopPropagation();
                    deleteMigration(mig);
                };

                div.appendChild(span);
                div.appendChild(delBtn);
                listContainer.appendChild(div);
            });
        }

    } catch (err) {
        console.error(err);
        listContainer.innerHTML = '<div style="color:red; padding:10px;">Error loading files</div>';
    }
}

let fileToDelete = null;

function deleteMigration(filename) {
    fileToDelete = filename;
    document.getElementById('delete-filename').textContent = filename;
    document.getElementById('delete-confirm-modal').classList.add('open');
    
    // Bind the confirm button
    const btn = document.getElementById('confirm-delete-btn');
    btn.onclick = () => executeDelete();
}

function closeDeleteConfirmModal() {
    document.getElementById('delete-confirm-modal').classList.remove('open');
    fileToDelete = null;
}

async function executeDelete() {
    if (!fileToDelete) return;
    
    const fullPath = `${currentProjectPath}/migrations/${fileToDelete}`;
    try {
        // Use query parameter for DELETE request to avoid body issues
        const res = await fetch(`/api/file?path=${encodeURIComponent(fullPath)}`, {
            method: 'DELETE'
        });
        
        if (res.ok) {
            // If the deleted file was the one being edited, clear the editor
            if (currentEditingFile === fullPath) {
                if (editor) editor.setValue('');
                else document.getElementById('code-editor').value = '';
                document.getElementById('editor-filename').textContent = 'Select a file...';
                currentEditingFile = null;
            }
            refreshFileList();
            closeDeleteConfirmModal();
        } else {
            const data = await res.json();
            alert(data.error || 'Failed to delete file');
        }
    } catch (err) {
        console.error(err);
        alert('Error deleting file');
    }
}

async function loadConfigForEdit() {
    // Determine config filename again or store it
    // For simplicity, check existence or default
    let filename = 'migrate-mongo-config.js';
    try {
        const res = await fetch(`/api/fs/list?path=${encodeURIComponent(currentProjectPath)}`);
        const data = await res.json();
        if (data.files && data.files.includes('config.js')) filename = 'config.js';
    } catch (e) {}

    loadFile(`${currentProjectPath}/${filename}`);
}

function loadMigrationForEdit(filename) {
    loadFile(`${currentProjectPath}/migrations/${filename}`);
}

let currentEditorMode = 'code'; // 'code' or 'form'

async function loadFile(fullPath) {
    try {
        const res = await fetch(`/api/file?path=${encodeURIComponent(fullPath)}`);
        if (!res.ok) throw new Error('Failed to read file');
        const data = await res.json();
        const content = data.content;
        
        if (editor) {
            editor.setValue(content);
        } else {
            document.getElementById('code-editor').value = content;
        }
        
        document.getElementById('editor-filename').textContent = fullPath.split('/').pop();
        currentEditingFile = fullPath;

        // Check if it's a config file
        const isConfig = fullPath.endsWith('config.js') || fullPath.endsWith('migrate-mongo-config.js');
        
        const btnCode = document.getElementById('btn-view-code');
        const btnForm = document.getElementById('btn-view-form');

        if (isConfig) {
            btnCode.style.display = 'inline-block';
            btnForm.style.display = 'inline-block';
            // Default to form view for config
            parseConfigToForm(content);
            switchEditorMode('form');
        } else {
            btnCode.style.display = 'none';
            btnForm.style.display = 'none';
            switchEditorMode('code');
        }

    } catch (err) {
        console.error(err);
        alert('Error loading file');
    }
}

function formatCode() {
    // With CodeMirror, we might want to use a beautifier library, 
    // but for now let's keep the simple logic or rely on CodeMirror's auto-indent if available.
    // Since we don't have a full formatter loaded, we'll stick to the manual one but apply to editor.
    
    let content = editor ? editor.getValue() : document.getElementById('code-editor').value;
    
    try {
        // 1. Try JSON
        const obj = JSON.parse(content);
        const formatted = JSON.stringify(obj, null, 2);
        if (editor) editor.setValue(formatted);
        else document.getElementById('code-editor').value = formatted;
        return;
    } catch (e) {
        // Not JSON, continue
    }

    // 2. Try JS Object (Simple Indentation)
    // This is a basic formatter for JS objects/files
    let formatted = '';
    let indent = 0;
    const pad = '  ';
    let inString = false;
    let strChar = null;
        
        for (let i = 0; i < content.length; i++) {
            const char = content[i];
            
            // Handle Strings
            if (!inString && (char === '"' || char === "'" || char === '`')) {
                inString = true;
                strChar = char;
                formatted += char;
                continue;
            }
            if (inString) {
                formatted += char;
                if (char === strChar && content[i-1] !== '\\') {
                    inString = false;
                }
                continue;
            }
            
            // Handle Structure
            if (char === '{' || char === '[') {
                formatted += char + '\n' + pad.repeat(++indent);
                // Skip following whitespace to avoid double spacing
                while (content[i+1] && /\s/.test(content[i+1])) i++;
            } else if (char === '}' || char === ']') {
                formatted = formatted.trimEnd(); // Remove trailing whitespace/newlines
                formatted += '\n' + pad.repeat(--indent) + char;
            } else if (char === ',') {
                formatted += char + '\n' + pad.repeat(indent);
                while (content[i+1] && /\s/.test(content[i+1])) i++;
            } else if (char === ':') {
                formatted += ': ';
                while (content[i+1] && /\s/.test(content[i+1])) i++;
            } else {
                formatted += char;
            }
        }
        
        if (editor) editor.setValue(formatted);
        else document.getElementById('code-editor').value = formatted;
    }

function switchEditorMode(mode) {
    currentEditorMode = mode;
    const codeEditor = document.querySelector('.CodeMirror') || document.getElementById('code-editor');
    const configEditor = document.getElementById('config-editor');
    const btnCode = document.getElementById('btn-view-code');
    const btnForm = document.getElementById('btn-view-form');
    const btnFormat = document.getElementById('btn-format-code');

    if (mode === 'code') {
        codeEditor.style.display = 'block';
        configEditor.style.display = 'none';
        btnCode.classList.add('primary');
        btnCode.classList.remove('secondary');
        btnForm.classList.add('secondary');
        btnForm.classList.remove('primary');
        btnFormat.style.display = 'inline-block';
        
        updateCodeFromForm(); 
        if (editor) editor.refresh();
    } else {
        codeEditor.style.display = 'none';
        configEditor.style.display = 'block';
        btnForm.classList.add('primary');
        btnForm.classList.remove('secondary');
        btnCode.classList.add('secondary');
        btnCode.classList.remove('primary');
        btnFormat.style.display = 'none';
        
        // Sync code to form
        parseConfigToForm(editor ? editor.getValue() : document.getElementById('code-editor').value);
    }
}

function parseConfigToForm(content) {
    // Helper to extract value
    const extract = (key) => {
        // 1. Try quoted string
        let regex = new RegExp(`(${key}\\s*:\\s*(?:[^\\n]*\\|\\|\\s*)?)(['"])(.*?)\\2`);
        let match = content.match(regex);
        if (match) return match[3];
        
        // 2. Try unquoted (boolean, number)
        regex = new RegExp(`(${key}\\s*:\\s*)([^\\s,]+)`);
        match = content.match(regex);
        if (match) return match[2];
        
        return '';
    };

    document.getElementById('cfg-url').value = extract('url');
    document.getElementById('cfg-dbName').value = extract('databaseName');
    document.getElementById('cfg-migDir').value = extract('migrationsDir');
    document.getElementById('cfg-changelog').value = extract('changelogCollectionName');
    document.getElementById('cfg-lockCollection').value = extract('lockCollectionName');
    document.getElementById('cfg-lockTtl').value = extract('lockTtl');
    document.getElementById('cfg-extension').value = extract('migrationFileExtension');
    document.getElementById('cfg-useFileHash').value = extract('useFileHash');
    document.getElementById('cfg-moduleSystem').value = extract('moduleSystem');
}

function updateCodeFromForm() {
    // Safety check: only run for config files
    if (!currentEditingFile || (!currentEditingFile.endsWith('config.js') && !currentEditingFile.endsWith('migrate-mongo-config.js'))) {
        return;
    }

    let content = editor ? editor.getValue() : document.getElementById('code-editor').value;
    
    const updateOrAppend = (key, elementId, isString = true) => {
        const val = document.getElementById(elementId).value;
        
        let matched = false;
        if (isString) {
            // Matches key: ... "value" -> replaces value inside quotes
            const regex = new RegExp(`(${key}\\s*:\\s*(?:[^\\n]*\\|\\|\\s*)?)(['"])(.*?)\\2`);
            if (content.match(regex)) {
                content = content.replace(regex, `$1$2${val}$2`);
                matched = true;
            }
        } else {
            // Matches key: value -> replaces value directly
            const regex = new RegExp(`(${key}\\s*:\\s*)([^\\s,]+)`);
            if (content.match(regex)) {
                content = content.replace(regex, `$1${val}`);
                matched = true;
            }
        }

        if (!matched && val !== '') {
            // Append to the end of the object
            const lastBraceIndex = content.lastIndexOf('}');
            if (lastBraceIndex !== -1) {
                const beforeBrace = content.slice(0, lastBraceIndex);
                const trimmedBefore = beforeBrace.trimEnd();
                const needsComma = !trimmedBefore.endsWith(',') && !trimmedBefore.endsWith('{');
                
                let insertion = '';
                if (needsComma) insertion += ',';
                
                // Only add newline if the content before doesn't already end with one
                if (!beforeBrace.match(/[\r\n]\s*$/)) {
                    insertion += '\n';
                }
                
                insertion += `  ${key}: ${isString ? `"${val}"` : val}`;
                
                content = beforeBrace + insertion + content.slice(lastBraceIndex);
            }
        }
    };

    updateOrAppend('url', 'cfg-url');
    updateOrAppend('databaseName', 'cfg-dbName');
    updateOrAppend('migrationsDir', 'cfg-migDir');
    updateOrAppend('changelogCollectionName', 'cfg-changelog');
    updateOrAppend('lockCollectionName', 'cfg-lockCollection');
    updateOrAppend('lockTtl', 'cfg-lockTtl', false);
    updateOrAppend('migrationFileExtension', 'cfg-extension');
    updateOrAppend('useFileHash', 'cfg-useFileHash', false);
    updateOrAppend('moduleSystem', 'cfg-moduleSystem');

    if (editor) editor.setValue(content);
    else document.getElementById('code-editor').value = content;
}

async function saveCurrentFile() {
    if (!currentEditingFile) return alert('No file selected');
    
    // If in form mode, update code first
    if (currentEditorMode === 'form') {
        updateCodeFromForm();
    }

    const content = editor ? editor.getValue() : document.getElementById('code-editor').value;
    
    try {
        const res = await fetch('/api/file', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: currentEditingFile, content })
        });
        
        if (res.ok) {
            // Visual feedback
            const btn = document.querySelector('.editor-actions .btn.primary'); // Get the save button
            // Note: The save button is the last one in .editor-actions
            const saveBtns = document.querySelectorAll('.editor-actions button');
            const saveBtn = saveBtns[saveBtns.length - 1];
            
            const originalText = saveBtn.textContent;
            saveBtn.textContent = '[OK] Saved!';
            setTimeout(() => saveBtn.textContent = originalText, 2000);
        } else {
            alert('Failed to save file');
        }
    } catch (err) {
        console.error(err);
        alert('Error saving file');
    }
}

// Create Migration Modal Logic
function showCreateMigrationModal() {
    document.getElementById('create-migration-modal').classList.add('open');
    document.getElementById('new-migration-desc').focus();
}

function closeCreateMigrationModal() {
    document.getElementById('create-migration-modal').classList.remove('open');
    document.getElementById('new-migration-desc').value = '';
}

// --- Tooltip Logic ---
document.addEventListener('mouseover', function(e) {
    if (e.target.classList.contains('help-icon')) {
        const text = e.target.getAttribute('data-tooltip');
        if (!text) return;

        let tooltip = document.getElementById('js-tooltip');
        if (!tooltip) {
            tooltip = document.createElement('div');
            tooltip.id = 'js-tooltip';
            tooltip.className = 'custom-tooltip';
            document.body.appendChild(tooltip);
        }

        tooltip.textContent = text;
        tooltip.classList.add('visible');

        // Position logic
        const rect = e.target.getBoundingClientRect();
        const tooltipRect = tooltip.getBoundingClientRect();
        
        // Default: Top Center
        let top = rect.top - tooltipRect.height - 10;
        let left = rect.left + (rect.width / 2) - (tooltipRect.width / 2);

        // Check top edge
        if (top < 10) {
            // Flip to bottom
            top = rect.bottom + 10;
            tooltip.classList.add('bottom'); // Optional: for arrow styling
        }

        // Check left/right edges
        if (left < 10) left = 10;
        if (left + tooltipRect.width > window.innerWidth - 10) {
            left = window.innerWidth - tooltipRect.width - 10;
        }

        tooltip.style.top = `${top}px`;
        tooltip.style.left = `${left}px`;
    }
});

document.addEventListener('mouseout', function(e) {
    if (e.target.classList.contains('help-icon')) {
        const tooltip = document.getElementById('js-tooltip');
        if (tooltip) {
            tooltip.classList.remove('visible');
        }
    }
});

async function createNewMigration() {
    const descInput = document.getElementById('new-migration-desc');
    const desc = descInput.value.trim();
    
    if (!desc) return alert('Please enter a description');
    
    // Determine config path
    let configFileName = 'migrate-mongo-config.js';
    try {
        const res = await fetch(`/api/fs/list?path=${encodeURIComponent(currentProjectPath)}`);
        const data = await res.json();
        if (data.files && data.files.includes('config.js')) configFileName = 'config.js';
    } catch (e) {}
    
    const configPath = `${currentProjectPath}/${configFileName}`;
    
    // Run command
    runCommand('node', ['src/cli.js', 'create', `"${desc}"`, '-c', configPath]);
    
    closeCreateMigrationModal();
}

