import * as vscode from 'vscode';
import * as path from 'path';

interface RunConfig {
    name: string;
    type: 'file' | 'current';
    program?: string;
    command?: string;
    args?: string;
    cwd?: string;
}

const CURRENT_FILE_CONFIG: RunConfig = {
    name: "Current File",
    type: 'current'
};

let sbSelector: vscode.StatusBarItem;
let sbRunBtn: vscode.StatusBarItem;
let sbDebugBtn: vscode.StatusBarItem;

let activeConfig: RunConfig = CURRENT_FILE_CONFIG;
let activeTerminal: vscode.Terminal | undefined;

export function activate(context: vscode.ExtensionContext) {

    createStatusBarUI();

    context.subscriptions.push(
        vscode.commands.registerCommand('runEntryPoint.run', () => execute('run')),
        vscode.commands.registerCommand('runEntryPoint.debug', () => execute('debug')),
        vscode.commands.registerCommand('runEntryPoint.selectConfig', showConfigSelector),
        vscode.commands.registerCommand('runEntryPoint.addConfig', openAddConfigUI),
        vscode.commands.registerCommand('runEntryPoint.editConfig', () => {
            vscode.commands.executeCommand('workbench.action.openWorkspaceSettings', 'runEntryPoint.configurations');
        }),

        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('runEntryPoint')) {validateActiveConfig();}
        })
    );
}

function createStatusBarUI() {
    // run
    sbRunBtn = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    sbRunBtn.text = "$(play)";
    sbRunBtn.tooltip = "Run (Shift+F10 style)";
    sbRunBtn.command = 'runEntryPoint.run';
    sbRunBtn.color = "#90ee90";
    sbRunBtn.show();

    // debug
    sbDebugBtn = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
    sbDebugBtn.text = "$(debug-alt)";
    sbDebugBtn.tooltip = "Debug (Shift+F9 style)";
    sbDebugBtn.command = 'runEntryPoint.debug';
    sbDebugBtn.color = "#FFB366";
    sbDebugBtn.show();

    // config selector
    sbSelector = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 98);
    sbSelector.command = 'runEntryPoint.selectConfig';
    updateStatusBar();
    sbSelector.show();
}

function updateStatusBar() {
    sbSelector.text = activeConfig.name;
    const target = activeConfig.program ? path.basename(activeConfig.program) : "Active File";
    sbSelector.tooltip = `Target: ${target}\nClick to change configuration`;
}

function validateActiveConfig() {
    const configs = getStoredConfigs();
    if (activeConfig.type !== 'current') {
        if (!configs.find(c => c.name === activeConfig.name)) {
            activeConfig = CURRENT_FILE_CONFIG;
            updateStatusBar();
        }
    }
}

function getStoredConfigs(): RunConfig[] {
    return vscode.workspace.getConfiguration('runEntryPoint').get('configurations') || [];
}

/**
 * UI:
 */
async function showConfigSelector() {
    const configs = getStoredConfigs();

    interface ExtendedQuickPickItem extends vscode.QuickPickItem {
        config?: RunConfig;
        isAddAction?: boolean;
        command?: string;
    }

    const items: ExtendedQuickPickItem[] = [
        { 
            label: "$(file) Current File", 
            description: "Run whatever is open", 
            config: CURRENT_FILE_CONFIG 
        },
        { label: "", kind: vscode.QuickPickItemKind.Separator },
        ...configs.map(c => ({
            label: `$(gear) ${c.name}`,
            description: c.program ? path.basename(c.program) : '',
            detail: c.args ? `Args: ${c.args}` : undefined,
            config: c
        })),
        { label: "", kind: vscode.QuickPickItemKind.Separator },
        { label: "$(add) Add New Configuration...", isAddAction: true },
        { label: "$(edit) Edit Configurations (JSON)...", command: 'runEntryPoint.editConfig' }
    ];

    const selected = await vscode.window.showQuickPick<ExtendedQuickPickItem>(items, {
        placeHolder: 'Select Run/Debug Configuration'
    });

    if (selected) {
        if (selected.isAddAction) {openAddConfigUI();}
        else if (selected.command) {vscode.commands.executeCommand(selected.command);}
        else if (selected.config) {
            activeConfig = selected.config;
            updateStatusBar();
        }
    }
}
async function openAddConfigUI() {
    const fileUris = await vscode.window.showOpenDialog({
        canSelectFiles: true, openLabel: 'Select Entry File'
    });
    if (!fileUris || fileUris.length === 0) {return;}

    const filePath = fileUris[0].fsPath;
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(fileUris[0]);
    
    // path
    let programPath = filePath;
    if (workspaceFolder) {
        programPath = path.join('${workspaceFolder}', path.relative(workspaceFolder.uri.fsPath, filePath));
    }

    // Code Runner
    const ext = path.extname(filePath);
    let defaultCmd = getExecutorForExt(ext) || "python";

    const name = await vscode.window.showInputBox({ value: `Run ${path.basename(filePath)}`, prompt: 'Config Name' });
    if (!name) {return;}

    const command = await vscode.window.showInputBox({ value: defaultCmd, prompt: 'Executor Command (e.g. python, node, g++)' });
    if (!command) {return;}
    
    const args = await vscode.window.showInputBox({ prompt: 'Arguments (optional)', placeHolder: '--debug' });

    const newConfig: RunConfig = { name, type: 'file', program: programPath, command, args: args || "" };
    
    const config = vscode.workspace.getConfiguration('runEntryPoint');
    const existing = config.get<RunConfig[]>('configurations') || [];
    await config.update('configurations', [...existing, newConfig], vscode.ConfigurationTarget.Workspace);
    
    activeConfig = newConfig;
    updateStatusBar();
}


// 优先级：Code Runner > default

function getExecutorForExt(ext: string): string | undefined {
    // Code Runner
    const codeRunnerMap = vscode.workspace.getConfiguration('code-runner').get<any>('executorMap');
    if (codeRunnerMap && codeRunnerMap[ext] && typeof codeRunnerMap[ext] === 'string') {
        return codeRunnerMap[ext];
    }
    
    // default
    const defaultMap: {[key:string]: string} = {
        '.py': 'python', '.js': 'node', '.ts': 'ts-node', '.go': 'go run',
        '.java': 'java', '.c': 'gcc', '.cpp': 'g++', '.sh': 'bash', '.rb': 'ruby'
    };
    return defaultMap[ext];
}

async function getPythonPath(scopeUri: vscode.Uri | undefined): Promise<string> {
    try {
        const pyExt = vscode.extensions.getExtension('ms-python.python');
        if (pyExt) {
            if (!pyExt.isActive) {await pyExt.activate();}
            const details = pyExt.exports.settings.getExecutionDetails(scopeUri);
            if (details?.execCommand?.[0]) {return details.execCommand[0];}
        }
    } catch {}
    return 'python';
}


async function execute(mode: 'run' | 'debug') {
    const editor = vscode.window.activeTextEditor;
    let workspaceFolder: vscode.WorkspaceFolder | undefined;
    
    if (editor) {
        workspaceFolder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
    } else if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
        workspaceFolder = vscode.workspace.workspaceFolders[0];
    }
    const workspacePath = workspaceFolder ? workspaceFolder.uri.fsPath : "";

    // path
    let targetFile = "";
    if (activeConfig.type === 'current') {
        if (!editor) {
            vscode.window.showErrorMessage("No file open.");
            return;
        }
        targetFile = editor.document.fileName;
    } else {
        if (!activeConfig.program) {return;}
        targetFile = activeConfig.program.replace(/\$\{workspaceFolder\}/g, workspacePath);
    }

    // debug
    if (mode === 'debug') {
        startDebugging(targetFile, workspaceFolder, activeConfig.args);
        return;
    }

    // run
    let executor = activeConfig.command;
    
    // read ext
    if (!executor && activeConfig.type === 'current') {
        const ext = path.extname(targetFile);
        executor = getExecutorForExt(ext);
        
        // error
        if (!executor) {
            vscode.window.showErrorMessage(`No executor found for file extension '${ext}'. Please configure it in settings.`);
            return; 
        }
    }

    // py path
    if (executor?.trim() === 'python' || executor?.trim() === 'python3') {
        executor = await getPythonPath(workspaceFolder?.uri);
    }

    const args = activeConfig.args || "";
    let finalCommand = "";
    
    // c,d
    if (executor && executor.includes("$")) {
        const dir = path.dirname(targetFile);
        const fileName = path.basename(targetFile);
        const fileNameNoExt = path.parse(targetFile).name;
        
        finalCommand = executor
            .replace(/\$workspaceRoot/g, workspacePath)
            .replace(/\$dir/g, dir)
            .replace(/\$fileNameWithoutExt/g, fileNameNoExt)
            .replace(/\$fileName/g, fileName);
    } else {
        const quote = (s: string) => s.includes(' ') ? `"${s}"` : s;
        finalCommand = `${quote(executor || "")} ${quote(targetFile)} ${args}`;
    }

    // terminal
    if (!activeTerminal || activeTerminal.exitStatus) {
        activeTerminal = vscode.window.createTerminal("Super Runner");
    }
    activeTerminal.show(true);
    
    // clear
    const shouldClear = vscode.workspace.getConfiguration('runEntryPoint').get('clearPreviousOutput');
    
    if (shouldClear) {
        try {
            await vscode.commands.executeCommand('workbench.action.terminal.clear');
            
            // wait for clear
            await new Promise(resolve => setTimeout(resolve, 200)); 
        } catch (e) {
        }
    }

    activeTerminal.sendText(finalCommand, true);
}

async function startDebugging(filePath: string, workspaceFolder: vscode.WorkspaceFolder | undefined, args?: string) {
    const ext = path.extname(filePath);
    let debugConfig: vscode.DebugConfiguration;

    if (ext === '.py') {
        debugConfig = {
            type: 'python',
            name: 'Super Debug',
            request: 'launch',
            program: filePath,
            args: args ? args.split(' ') : [],
            console: 'integratedTerminal'
        };
    } else if (ext === '.js' || ext === '.ts') {
        debugConfig = {
            type: 'node',
            name: 'Super Debug',
            request: 'launch',
            program: filePath,
            args: args ? args.split(' ') : [],
            skipFiles: ["<node_internals>/**"]
        };
    } else {
        vscode.window.showErrorMessage("Auto-debug only supports Python and Node.js currently. Please configure launch.json manually.");
        return;
    }

    await vscode.debug.startDebugging(workspaceFolder, debugConfig);
}

export function deactivate() {}