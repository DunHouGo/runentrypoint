import * as vscode from 'vscode';
import * as path from 'path';

/**
 * 配置接口定义
 */
interface RunConfig {
    name: string;
    type: 'file' | 'current';
    program?: string;
    command?: string;
    args?: string;
    cwd?: string;
}

// 默认配置
const CURRENT_FILE_CONFIG: RunConfig = {
    name: "Current File",
    type: 'current'
};

// 状态栏项
let sbSelector: vscode.StatusBarItem;
let sbRunBtn: vscode.StatusBarItem;
let sbDebugBtn: vscode.StatusBarItem;

let activeConfig: RunConfig = CURRENT_FILE_CONFIG;
let activeTerminal: vscode.Terminal | undefined;

export function activate(context: vscode.ExtensionContext) {

    createStatusBarUI();

    context.subscriptions.push(
        vscode.commands.registerCommand('superRunner.run', () => execute('run')),
        vscode.commands.registerCommand('superRunner.debug', () => execute('debug')),
        vscode.commands.registerCommand('superRunner.selectConfig', showConfigSelector),
        vscode.commands.registerCommand('superRunner.addConfig', openAddConfigUI),
        vscode.commands.registerCommand('superRunner.editConfig', () => {
            vscode.commands.executeCommand('workbench.action.openWorkspaceSettings', 'superRunner.configurations');
        }),
        // 监听配置变化
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('superRunner')) {validateActiveConfig();}
        })
    );
}

function createStatusBarUI() {
    // 1. 运行按钮 (绿色)
    sbRunBtn = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    sbRunBtn.text = "$(play)";
    sbRunBtn.tooltip = "Run (Shift+F10 style)";
    sbRunBtn.command = 'superRunner.run';
    sbRunBtn.color = "#90ee90"; // Light Green
    sbRunBtn.show();

    // 2. 调试按钮 (橙色/红色) - 新增功能！
    sbDebugBtn = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
    sbDebugBtn.text = "$(debug-alt)";
    sbDebugBtn.tooltip = "Debug (Shift+F9 style)";
    sbDebugBtn.command = 'superRunner.debug';
    sbDebugBtn.color = "#FFB366"; // Light Orange
    sbDebugBtn.show();

    // 3. 配置选择器
    sbSelector = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 98);
    sbSelector.command = 'superRunner.selectConfig';
    updateStatusBar();
    sbSelector.show();
}

function updateStatusBar() {
    sbSelector.text = activeConfig.name;
    // 简单的提示
    const target = activeConfig.program ? path.basename(activeConfig.program) : "Active File";
    sbSelector.tooltip = `Target: ${target}\nClick to change configuration`;
}

function validateActiveConfig() {
    const configs = getStoredConfigs();
    if (activeConfig.type !== 'current') {
        // 如果当前选中的配置被删除了，回退到默认
        if (!configs.find(c => c.name === activeConfig.name)) {
            activeConfig = CURRENT_FILE_CONFIG;
            updateStatusBar();
        }
    }
}

function getStoredConfigs(): RunConfig[] {
    return vscode.workspace.getConfiguration('superRunner').get('configurations') || [];
}

/**
 * UI: 下拉选择配置
 */
async function showConfigSelector() {
    const configs = getStoredConfigs();

    // 修复 TS 类型报错，明确定义接口
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
        { label: "$(edit) Edit Configurations (JSON)...", command: 'superRunner.editConfig' }
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

/**
 * UI: 添加新配置向导
 */
async function openAddConfigUI() {
    const fileUris = await vscode.window.showOpenDialog({
        canSelectFiles: true, openLabel: 'Select Entry File'
    });
    if (!fileUris || fileUris.length === 0) {return;}

    const filePath = fileUris[0].fsPath;
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(fileUris[0]);
    
    // 生成相对路径
    let programPath = filePath;
    if (workspaceFolder) {
        programPath = path.join('${workspaceFolder}', path.relative(workspaceFolder.uri.fsPath, filePath));
    }

    // 猜测运行命令 (优先读取 Code Runner 的配置)
    const ext = path.extname(filePath);
    let defaultCmd = getExecutorForExt(ext) || "python";

    const name = await vscode.window.showInputBox({ value: `Run ${path.basename(filePath)}`, prompt: 'Config Name' });
    if (!name) {return;}

    const command = await vscode.window.showInputBox({ value: defaultCmd, prompt: 'Executor Command (e.g. python, node, g++)' });
    if (!command) {return;}
    
    const args = await vscode.window.showInputBox({ prompt: 'Arguments (optional)', placeHolder: '--debug' });

    const newConfig: RunConfig = { name, type: 'file', program: programPath, command, args: args || "" };
    
    const config = vscode.workspace.getConfiguration('superRunner');
    const existing = config.get<RunConfig[]>('configurations') || [];
    await config.update('configurations', [...existing, newConfig], vscode.ConfigurationTarget.Workspace);
    
    activeConfig = newConfig;
    updateStatusBar();
}

/**
 * 核心：获取文件的执行命令
 * 优先级：Code Runner 配置 > 插件默认配置 > 兜底
 */
function getExecutorForExt(ext: string): string | undefined {
    // 1. 尝试读取 Code Runner 的 executorMap
    const codeRunnerMap = vscode.workspace.getConfiguration('code-runner').get<any>('executorMap');
    if (codeRunnerMap && codeRunnerMap[ext] && typeof codeRunnerMap[ext] === 'string') {
        return codeRunnerMap[ext];
    }
    
    // 2. 插件自带默认值
    const defaultMap: {[key:string]: string} = {
        '.py': 'python', '.js': 'node', '.ts': 'ts-node', '.go': 'go run',
        '.java': 'java', '.c': 'gcc', '.cpp': 'g++', '.sh': 'bash', '.rb': 'ruby'
    };
    return defaultMap[ext];
}

/**
 * 核心逻辑：获取 Python 解释器路径
 */
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

/**
 * 统一执行入口 (Run 或 Debug)
 */
async function execute(mode: 'run' | 'debug') {
    const editor = vscode.window.activeTextEditor;
    let workspaceFolder: vscode.WorkspaceFolder | undefined;
    
    if (editor) {
        workspaceFolder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
    } else if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
        workspaceFolder = vscode.workspace.workspaceFolders[0];
    }
    const workspacePath = workspaceFolder ? workspaceFolder.uri.fsPath : "";

    // 1. 解析目标文件路径
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

    // 2. Debug 模式直接进入调试逻辑
    if (mode === 'debug') {
        startDebugging(targetFile, workspaceFolder, activeConfig.args);
        return;
    }

    // 3. Run 模式：解析执行器
    let executor = activeConfig.command;
    
    // 如果没有指定具体命令（Current File 模式），尝试根据后缀获取
    if (!executor && activeConfig.type === 'current') {
        const ext = path.extname(targetFile);
        executor = getExecutorForExt(ext);
        
        // 如果找不到执行器（比如你在看 .json 或 .md 文件），报错并停止
        if (!executor) {
            vscode.window.showErrorMessage(`No executor found for file extension '${ext}'. Please configure it in settings.`);
            return; 
        }
    }

    // 特殊处理 Python 路径
    if (executor?.trim() === 'python' || executor?.trim() === 'python3') {
        executor = await getPythonPath(workspaceFolder?.uri);
    }

    const args = activeConfig.args || "";
    let finalCommand = "";
    
    // 4. 构建最终命令
    if (executor && executor.includes("$")) {
        // 复杂命令模式
        const dir = path.dirname(targetFile);
        const fileName = path.basename(targetFile);
        const fileNameNoExt = path.parse(targetFile).name;
        
        finalCommand = executor
            .replace(/\$workspaceRoot/g, workspacePath)
            .replace(/\$dir/g, dir)
            .replace(/\$fileNameWithoutExt/g, fileNameNoExt)
            .replace(/\$fileName/g, fileName);
    } else {
        // 简单命令模式
        const quote = (s: string) => s.includes(' ') ? `"${s}"` : s;
        finalCommand = `${quote(executor || "")} ${quote(targetFile)} ${args}`;
    }

    // 5. 发送到终端 (修复白屏和命令断裂问题的关键部分)
    if (!activeTerminal || activeTerminal.exitStatus) {
        activeTerminal = vscode.window.createTerminal("Super Runner");
    }
    activeTerminal.show(true);
    
    // 检查设置：是否清屏
    const shouldClear = vscode.workspace.getConfiguration('superRunner').get('clearPreviousOutput');
    
    if (shouldClear) {
        try {
            // 执行清屏
            await vscode.commands.executeCommand('workbench.action.terminal.clear');
            
            // --- 关键修复：等待 200ms 让终端喘口气 ---
            await new Promise(resolve => setTimeout(resolve, 200)); 
        } catch (e) {
            // 忽略清屏错误
        }
    }

    // 发送文本 (addNewLine: true)
    activeTerminal.sendText(finalCommand, true);
}

/**
 * 调试逻辑
 * 动态生成 Launch Config
 */
async function startDebugging(filePath: string, workspaceFolder: vscode.WorkspaceFolder | undefined, args?: string) {
    const ext = path.extname(filePath);
    let debugConfig: vscode.DebugConfiguration;

    // 根据语言生成配置
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