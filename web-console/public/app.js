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
    if (stepNum === 4) {
        loadTestDbList();
    }
}

function nextStep() {
    const current = document.querySelector('.step.active');
    const next = parseInt(current.dataset.step) + 1;
    if (next <= 4) activateStep(next);
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

        // Add event listener to checkboxes to update validation rules display
        const updateRulesDisplay = async () => {
            const selected = document.querySelectorAll('#validate-list input[type="checkbox"]:checked');
            const rulesDisplay = document.getElementById('validation-rules-display');
            const dbList = document.getElementById('forbidden-db-list');
            const colList = document.getElementById('forbidden-col-list');
            
            if (selected.length === 1) {
                // Only show rules if exactly one project is selected (to avoid confusion)
                const projectPath = selected[0].value;
                try {
                    const res = await fetch(`/api/validation-rules?projectPath=${encodeURIComponent(projectPath)}`);
                    const rules = await res.json();
                    
                    dbList.innerHTML = rules.forbidden.database.map(op => `<li>${op}</li>`).join('');
                    colList.innerHTML = rules.forbidden.collections.map(op => `<li>${op}</li>`).join('');
                    
                    rulesDisplay.style.display = 'block';
                } catch (e) {
                    console.error('Failed to fetch rules', e);
                    rulesDisplay.style.display = 'none';
                }
            } else {
                rulesDisplay.style.display = 'none';
            }
        };

        container.querySelectorAll('input').forEach(input => {
            input.addEventListener('change', updateRulesDisplay);
        });
        
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

async function loadTestDbList() {
    const select = document.getElementById('test-db-select');
    if (!select) return;
    
    // Save current selection if any
    const currentSelection = select.value;
    
    select.innerHTML = '<option value="">Loading...</option>';
    
    try {
        const res = await fetch('/api/projects');
        const projects = await res.json();
        
        select.innerHTML = '<option value="">-- Select Database --</option>';
        
        let foundCurrent = false;

        projects.forEach(p => {
            const option = document.createElement('option');
            const path = `databases/${p.name}`;
            option.value = path;
            option.textContent = p.name;
            
            // Priority: 1. Previously selected in this dropdown, 2. Current global project
            if (currentSelection === path) {
                option.selected = true;
                foundCurrent = true;
            } else if (!currentSelection && currentProjectPath && currentProjectPath.endsWith(p.name)) {
                option.selected = true;
                foundCurrent = true;
            }
            
            select.appendChild(option);
        });
        
        // If current project is manual and not in the list
        if (currentProjectPath && !foundCurrent) {
             // Check if we already added it (manual path might match p.name logic above but let's be safe)
             // If the loop above didn't select anything, and we have a currentProjectPath
             const name = currentProjectPath.split('/').pop();
             const option = document.createElement('option');
             option.value = currentProjectPath;
             option.textContent = `${name} (Current)`;
             option.selected = true;
             select.appendChild(option);
        }
        
    } catch (err) {
        console.error(err);
        select.innerHTML = '<option value="">Error loading projects</option>';
    }
}

function runLocalUp() {
    const select = document.getElementById('test-db-select');
    const selectedPath = select ? select.value : currentProjectPath;
    
    if (!selectedPath) return alert('Please select a database first');
    
    const configPath = `${selectedPath}/config.js`;
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
        // Add timestamp to prevent caching
        const res = await fetch(`/api/file?path=${encodeURIComponent(fullPath)}&t=${Date.now()}`);
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
    let content = editor ? editor.getValue() : document.getElementById('code-editor').value;
    
    // 1. Try Prettier (Best)
    try {
        if (window.prettier && window.prettierPlugins) {
            const formatted = prettier.format(content, {
                parser: "babel",
                plugins: prettierPlugins,
                semi: true,
                singleQuote: true,
                trailingComma: 'es5',
                tabWidth: 2
            });
            
            if (editor) editor.setValue(formatted);
            else document.getElementById('code-editor').value = formatted;
            return;
        }
    } catch (e) {
        console.error("Prettier formatting failed:", e);
        // Fallthrough to fallback
    }

    // 2. Fallback: CodeMirror Smart Indent
    if (editor) {
        const totalLines = editor.lineCount();
        editor.operation(() => {
            for (let i = 0; i < totalLines; i++) {
                editor.indentLine(i, "smart");
            }
        });
        return;
    }

    // 3. Fallback: Basic JSON
    try {
        const obj = JSON.parse(content);
        const formatted = JSON.stringify(obj, null, 2);
        document.getElementById('code-editor').value = formatted;
    } catch (e) {
        // Ignore
    }
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

    // Parse Validation Rules
    loadForbiddenOpsUI(content);
}

async function loadForbiddenOpsUI(content) {
    try {
        // 1. Fetch Default Rules
        const res = await fetch('/api/default-validation-rules');
        const defaultRules = await res.json();
        
        const dbContainer = document.getElementById('forbidden-db-checks');
        const colContainer = document.getElementById('forbidden-col-checks');
        const sysContainer = document.getElementById('forbidden-sys-checks');
        const admContainer = document.getElementById('forbidden-adm-checks');
        
        dbContainer.innerHTML = '';
        colContainer.innerHTML = '';
        sysContainer.innerHTML = '';
        admContainer.innerHTML = '';

        // 2. Parse Current Config for Overrides
        // We look for validation: { forbidden: { ... } }
        // This is tricky with regex. Let's try to extract the 'validation' object string first.
        let currentForbiddenDb = null;
        let currentForbiddenCol = null;
        let currentForbiddenSys = null;
        let currentForbiddenAdm = null;

        // Extract validation object block
        // Matches validation: { ... } allowing for nested braces (simple level)
        // A robust parser is better, but for now let's assume standard formatting or simple structure
        // Or, we can assume if it's not present, it's default.
        
        // Let's try to find the 'forbidden' section inside 'validation'
        // validation: { ... forbidden: { ... database: [ ... ], collections: [ ... ] } ... }
        
        // Helper to extract array from string
        const extractArray = (str, key) => {
            console.log(`Extracting ${key}...`);
            // Regex to find "key:"
            const keyRegex = new RegExp(`${key}\\s*:`);
            const keyMatch = str.match(keyRegex);
            if (!keyMatch) {
                console.log(`Key ${key} not found`);
                return null;
            }
            
            // Look for [ after the key
            const afterKey = str.slice(keyMatch.index + keyMatch[0].length);
            const openBracketIndex = afterKey.indexOf('[');
            if (openBracketIndex === -1) return null;
            
            // Find closing bracket
            const closeBracketIndex = afterKey.indexOf(']', openBracketIndex);
            if (closeBracketIndex === -1) return null;
            
            const arrayContent = afterKey.slice(openBracketIndex + 1, closeBracketIndex);
            console.log(`Found content for ${key}:`, arrayContent);
            
            return arrayContent
                .split(',')
                .map(s => s.trim())
                .filter(s => s)
                .map(s => s.replace(/['"]/g, '')); // Remove quotes
        };

        // Find validation block
        // We use a more robust approach: Find "forbidden:" and search for arrays after it.
        // This avoids issues with matching the exact closing brace of the object.
        const forbiddenStart = content.search(/forbidden\s*:\s*{/);
        
        if (forbiddenStart !== -1) {
            // Take a chunk of text starting from forbidden
            // We limit the chunk size to avoid scanning the whole file if it's huge, 
            // but config files are small.
            const forbiddenSection = content.slice(forbiddenStart);
            
            currentForbiddenDb = extractArray(forbiddenSection, 'database');
            currentForbiddenCol = extractArray(forbiddenSection, 'collections');
            currentForbiddenSys = extractArray(forbiddenSection, 'system');
            currentForbiddenAdm = extractArray(forbiddenSection, 'admin');
        }

        // 3. Generate Checkboxes
        const createCheckbox = (op, container, currentList, defaultList) => {
            const div = document.createElement('div');
            div.className = 'checkbox-item';
            
            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.id = `chk-forbid-${op}`;
            checkbox.value = op;
            
            // Logic:
            // If currentList is null (no override), use Default (Checked)
            // If currentList exists, check if op is in it.
            if (currentList === null) {
                checkbox.checked = true; // Default is forbidden
            } else {
                checkbox.checked = currentList.includes(op);
            }
            
            const label = document.createElement('label');
            label.htmlFor = `chk-forbid-${op}`;
            label.textContent = op;
            
            div.appendChild(checkbox);
            div.appendChild(label);

            // Add Tooltip
            const desc = defaultRules.descriptions && defaultRules.descriptions[op];
            if (desc) {
                const helpIcon = document.createElement('span');
                helpIcon.className = 'help-icon';
                helpIcon.textContent = '?';
                helpIcon.style.marginLeft = '8px';
                helpIcon.style.cursor = 'help';
                helpIcon.style.fontSize = '0.85em';
                helpIcon.style.color = '#fff';
                helpIcon.style.background = '#999';
                helpIcon.style.borderRadius = '50%';
                helpIcon.style.width = '16px';
                helpIcon.style.height = '16px';
                helpIcon.style.display = 'inline-flex';
                helpIcon.style.alignItems = 'center';
                helpIcon.style.justifyContent = 'center';
                helpIcon.setAttribute('data-tooltip', desc);
                div.appendChild(helpIcon);
            }

            container.appendChild(div);
        };

        if (defaultRules.forbidden.database) defaultRules.forbidden.database.forEach(op => createCheckbox(op, dbContainer, currentForbiddenDb, defaultRules.forbidden.database));
        if (defaultRules.forbidden.collections) defaultRules.forbidden.collections.forEach(op => createCheckbox(op, colContainer, currentForbiddenCol, defaultRules.forbidden.collections));
        if (defaultRules.forbidden.system) defaultRules.forbidden.system.forEach(op => createCheckbox(op, sysContainer, currentForbiddenSys, defaultRules.forbidden.system));
        if (defaultRules.forbidden.admin) defaultRules.forbidden.admin.forEach(op => createCheckbox(op, admContainer, currentForbiddenAdm, defaultRules.forbidden.admin));

    } catch (e) {
        console.error('Error loading forbidden ops UI', e);
    }
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

    // Update Validation Rules
    // We need to reconstruct the validation object based on checkboxes
    // Logic:
    // 1. Get all checkboxes
    // 2. Get default rules (we need them to know what to compare against, or just list all checked)
    // Actually, the requirement is: "Cancel is override".
    // If a box is UNCHECKED, it means we want to ALLOW it.
    // But the config stores what is FORBIDDEN.
    // So we just need to list all CHECKED items in the config.
    // BUT, if the list of checked items is IDENTICAL to default, we can remove the override (cleaner).
    // However, for simplicity and explicitness, let's just write what is checked.
    // Wait, if we write everything, the config becomes huge.
    // Better: Only write if different from default?
    // The user said: "No config = default (all checked)".
    // So if all are checked, we can remove the validation block?
    // Or just write the list of checked items.
    
    // Let's fetch defaults again to compare? Or store them globally.
    // For now, let's just write the list of checked items into the config.
    
    const getChecked = (containerId) => {
        return Array.from(document.querySelectorAll(`#${containerId} input:checked`)).map(cb => cb.value);
    };
    
    const checkedDb = getChecked('forbidden-db-checks');
    const checkedCol = getChecked('forbidden-col-checks');
    const checkedSys = getChecked('forbidden-sys-checks');
    const checkedAdm = getChecked('forbidden-adm-checks');
    
    // We need to insert/update:
    // validation: {
    //   forbidden: {
    //     database: [...],
    //     collections: [...],
    //     system: [...],
    //     admin: [...]
    //   }
    // }
    
    // Construct the validation object string
    const dbListStr = `[${checkedDb.map(s => `'${s}'`).join(', ')}]`;
    const colListStr = `[${checkedCol.map(s => `'${s}'`).join(', ')}]`;
    const sysListStr = `[${checkedSys.map(s => `'${s}'`).join(', ')}]`;
    const admListStr = `[${checkedAdm.map(s => `'${s}'`).join(', ')}]`;
    
    const validationBlock = `
  validation: {
    forbidden: {
      database: ${dbListStr},
      collections: ${colListStr},
      system: ${sysListStr},
      admin: ${admListStr}
    }
  }`;

    // Replace or Append validation block
    // Regex to find existing validation block
    // Match validation: { forbidden: { ... } } - handles nested braces by matching specific structure
    const validationRegex = /validation\s*:\s*\{\s*forbidden\s*:\s*\{[\s\S]*?\}\s*\}\s*,?/;
    
    if (content.match(validationRegex)) {
        // Replace existing
        content = content.replace(validationRegex, validationBlock.trim());
    } else {
        // Append before the last brace
        const lastBraceIndex = content.lastIndexOf('}');
        if (lastBraceIndex !== -1) {
            const before = content.slice(0, lastBraceIndex).trimEnd();
            const needsComma = !before.endsWith(',') && !before.endsWith('{');
            content = before + (needsComma ? ',' : '') + validationBlock + '\n};';
        }
    }

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

