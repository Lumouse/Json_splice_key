/**
 * JSON Row Header Hint Extension for VS Code
 *
 * This extension provides inline hints for JSON array data rows, showing column headers
 * after each value. It also supports hover-based navigation to related data in other JSON files
 * based on configurable links.
 *
 * Supported JSON structure:
 * [
 *   ["header1", "header2", "header3"],  // Header row with string column names
 *   [value1, value2, value3],           // Data rows
 *   [value4, [nested1, nested2], value6]  // Supports nested arrays
 * ]
 */

import * as vscode from 'vscode';
import { parse as parseJson, getLocation } from 'jsonc-parser';

// Global decoration type for inline hints
let decorationType: vscode.TextEditorDecorationType;

/**
 * Activates the extension when a JSON file is opened.
 * Sets up event listeners for editor changes and registers providers.
 */
export function activate(context: vscode.ExtensionContext) {
    console.log('JSON Row Hint extension activated');

    // Create decoration type for inline hints with gray color
    decorationType = vscode.window.createTextEditorDecorationType({});

    /**
     * Updates hints for the given editor.
     * Called when active editor changes, selection changes, or document is modified.
     */
    const updateForEditor = (editor?: vscode.TextEditor) => {
        if (!editor) { return; }
        try {
            provideHint(editor);
        } catch (e) {
            // Fail silently on errors to avoid disrupting the editor
            editor.setDecorations(decorationType, []);
        }
    };

    // Listen for active editor changes
    context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(updateForEditor));

    // Listen for cursor/selection changes
    context.subscriptions.push(vscode.window.onDidChangeTextEditorSelection((e) => updateForEditor(e.textEditor)));

    // Listen for document changes in the active editor
    context.subscriptions.push(vscode.workspace.onDidChangeTextDocument((e) => {
        if (vscode.window.activeTextEditor && e.document === vscode.window.activeTextEditor.document) {
            provideHint(vscode.window.activeTextEditor);
        }
    }));

    // Register hover provider for JSON files to show navigation links
    const hoverProvider = vscode.languages.registerHoverProvider('json', {
        provideHover: provideHover
    });
    context.subscriptions.push(hoverProvider);

    // Register command to open target files at specific lines
    const openTargetCommand = vscode.commands.registerCommand('json-row-hint.openTarget', async (filePath: string, line: number, column: number) => {
        const uri = vscode.Uri.file(filePath);
        const doc = await vscode.workspace.openTextDocument(uri);
        const editor = await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside });
        const pos = new vscode.Position(line, column);
        editor.selection = new vscode.Selection(pos, pos);
        editor.revealRange(new vscode.Range(pos, pos));
    });
    context.subscriptions.push(openTargetCommand);

    // Initial update for currently active editor
    updateForEditor(vscode.window.activeTextEditor);
}

/**
 * Deactivates the extension and cleans up resources.
 */
export function deactivate() {
    if (decorationType) {
        decorationType.dispose();
    }
}

/**
 * Provides hover information for JSON files, showing navigation links to related data.
 * When hovering over values in configured columns, displays links to matching rows in target files.
 */
async function provideHover(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken): Promise<vscode.Hover | null> {
    console.log('provideHover called for', document.fileName, 'at position', position);

    // Get the full text of the document
    const text = document.getText();

    // Parse the JSON
    let root: any;
    try {
        root = parseJson(text);
    } catch (err) {
        return null;
    }

    // Validate that it's an array of arrays with string headers
    if (!Array.isArray(root) || root.length === 0 || !Array.isArray(root[0]) || !root[0].every((s: any) => typeof s === 'string')) {
        console.log('Hover: Root structure invalid');
        return null;
    }

    // Get the JSON path at the cursor position using jsonc-parser
    const offset = document.offsetAt(position);
    let loc = getLocation(text, offset - 1); // offset-1 to handle cursor positioning
    let path: (string | number)[] = loc.path as any;
    console.log('Hover: Path', path);

    // Must be inside an array element
    if (!Array.isArray(path) || path.length < 2) {
        return null;
    }

    // Extract row index, column index, and optional array index from path
    const rowIdx = path[0] as number;
    let colIdx: number | undefined;
    let arrayIdx: number | undefined;
    for (let i = 1; i < path.length; i++) {
        if (typeof path[i] === 'number') {
            if (colIdx === undefined) {
                colIdx = path[i] as number;
            } else {
                arrayIdx = path[i] as number;
                break;
            }
        }
    }
    console.log('Hover: rowIdx', rowIdx, 'colIdx', colIdx, 'arrayIdx', arrayIdx);

    // Validate indices
    if (typeof rowIdx !== 'number' || typeof colIdx !== 'number' || rowIdx < 1) {
        return null;
    }

    // Get the column header
    const header = root[0][colIdx];
    if (typeof header !== 'string') { return null; }

    // Get the current value, handling nested arrays
    let currentValue = root[rowIdx][colIdx];
    if (arrayIdx !== undefined && Array.isArray(currentValue)) {
        currentValue = currentValue[arrayIdx];
    }
    console.log('Hover: header', header, 'currentValue', currentValue);

    // Get configuration for this source file
    const sourceFile = vscode.workspace.asRelativePath(document.uri);
    const config = vscode.workspace.getConfiguration('json-row-hint');
    const links = config.get('links') as any;

    // Check if links are configured for this file and column
    if (!links || !links[sourceFile] || !links[sourceFile][header] || !Array.isArray(links[sourceFile][header])) {
        console.log('Hover: No links configured for', sourceFile, header);
        return null;
    }

    const targets = links[sourceFile][header];
    console.log('Hover: targets', targets);
    const foundTargets: { file: string, line: number }[] = [];

    // Search each target file for matching values
    for (const target of targets) {
        const targetFile = target.targetFile;
        const targetColumn = target.targetColumn !== undefined ? target.targetColumn : 0;

        // Get workspace folder
        const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
        if (!workspaceFolder) {
            console.log('Hover: No workspace folder');
            continue;
        }

        // Load target file
        const targetUri = vscode.Uri.joinPath(workspaceFolder.uri, targetFile);
        console.log('Hover: Loading target', targetFile);
        let targetRoot: any;
        try {
            const targetDoc = await vscode.workspace.openTextDocument(targetUri);
            const targetText = targetDoc.getText();
            targetRoot = parseJson(targetText);
        } catch (e) {
            console.log('Hover: Failed to load target', targetFile, e);
            continue;
        }

        // Validate target file structure
        if (!Array.isArray(targetRoot) || targetRoot.length === 0 || !Array.isArray(targetRoot[0])) {
            continue;
        }

        // Find target column index
        let targetColIdx: number;
        if (typeof targetColumn === 'string') {
            targetColIdx = targetRoot[0].indexOf(targetColumn);
            if (targetColIdx < 0) continue;
        } else {
            targetColIdx = targetColumn;
            if (targetColIdx >= targetRoot[0].length) continue;
        }

        // Search for matching value in target file
        for (let i = 1; i < targetRoot.length; i++) {
            if (targetRoot[i][targetColIdx] === currentValue) {
                foundTargets.push({ file: targetFile, line: i });
                break; // Stop at first match
            }
        }
    }

    // Create a map of found targets
    const foundMap: { [file: string]: number } = {};
    for (const found of foundTargets) {
        foundMap[found.file] = found.line;
    }

    // Build hover content with links
    const hover = new vscode.MarkdownString();
    hover.supportHtml = true;
    hover.isTrusted = true; // Allow command links
    hover.appendText(`查找数据: ${JSON.stringify(currentValue)}\n`);

    // Add links for each target
    for (const target of targets) {
        const file = target.targetFile;
        if (foundMap[file] !== undefined) {
            // Create command URI to open target file
            const args = [vscode.Uri.joinPath(vscode.workspace.getWorkspaceFolder(document.uri)!.uri, file).fsPath, foundMap[file], 0];
            const commandUri = `command:json-row-hint.openTarget?${encodeURIComponent(JSON.stringify(args))}`;
            hover.appendMarkdown(`[__${file}__](${commandUri})`);
            hover.appendText('\n');
        } else {
            hover.appendText(`${file} (未找到)\n`);
        }
    }

    return new vscode.Hover(hover);
}

/**
 * Extracts the complete array text if the current line is part of a multi-line formatted array.
 * Returns the array text and the starting line number, or null if not found.
 */
function extractCompleteArray(doc: vscode.TextDocument, startLine: number): { text: string, startLine: number } | null {
    const maxLines = 100;
    let bracketCount = 0;
    let foundStart = false;
    let arrayStartLine = startLine;

    // First, find the opening bracket by going upwards
    // Stop when bracketCount becomes negative (found unmatched opening bracket)
    for (let i = startLine; i >= Math.max(0, startLine - maxLines); i--) {
        const lineText = doc.lineAt(i).text;
        // Scan from right to left to count brackets
        for (let j = lineText.length - 1; j >= 0; j--) {
            if (lineText[j] === ']') {
                bracketCount++;
            } else if (lineText[j] === '[') {
                bracketCount--;
                if (bracketCount < 0) {
                    // Found an unmatched opening bracket
                    arrayStartLine = i;
                    foundStart = true;
                    break;
                }
            }
        }
        if (foundStart) break;
    }

    if (!foundStart) {
        console.log('extractCompleteArray: Could not find array start');
        return null;
    }

    // Now extract from start line to matching closing bracket
    bracketCount = 0;
    let lines: string[] = [];
    let endLine = arrayStartLine;

    for (let i = arrayStartLine; i < doc.lineCount && i < arrayStartLine + maxLines; i++) {
        const lineText = doc.lineAt(i).text;
        lines.push(lineText);

        for (let char of lineText) {
            if (char === '[') {
                bracketCount++;
            } else if (char === ']') {
                bracketCount--;
                if (bracketCount === 0) {
                    endLine = i;
                    break;
                }
            }
        }
        if (bracketCount === 0) break;
    }

    if (bracketCount !== 0) {
        console.log('extractCompleteArray: Unmatched brackets');
        return null;
    }

    // Verify this is NOT the header array by checking if it has multiple top-level elements
    // The header array will have all string values, but a data array should have at least one non-string or mixed types
    const fullText = lines.join('\n');
    try {
        const parsed = parseJson(fullText);
        if (Array.isArray(parsed) && parsed.length >= 2) {
            // Check if the first element is an array (indicating header row format)
            if (Array.isArray(parsed[0]) && parsed[0].every((s: any) => typeof s === 'string')) {
                // This looks like a table structure where parsed[0] is headers
                // parsed[1] is a data row. Extract just the data row
                if (parsed.length > 1 && Array.isArray(parsed[1])) {
                    // Return just the second element (first data row)
                    // Find where parsed[1] starts in the text
                    const firstRowStart = fullText.indexOf('[', fullText.indexOf('[') + 1);
                    if (firstRowStart >= 0) {
                        let brackets = 0;
                        let rowEnd = firstRowStart;
                        for (let i = firstRowStart; i < fullText.length; i++) {
                            if (fullText[i] === '[') brackets++;
                            else if (fullText[i] === ']') {
                                brackets--;
                                if (brackets === 0) {
                                    rowEnd = i;
                                    break;
                                }
                            }
                        }
                        const dataRowText = fullText.substring(firstRowStart, rowEnd + 1);
                        const dataRowStartOffset = doc.offsetAt(new vscode.Position(arrayStartLine, 0)) + fullText.indexOf(dataRowText.trim());
                        // Count newlines to get actual line number
                        let dataRowLineNum = arrayStartLine;
                        for (let i = 0; i < firstRowStart; i++) {
                            if (fullText[i] === '\n') dataRowLineNum++;
                        }
                        return { text: dataRowText, startLine: dataRowLineNum };
                    }
                }
            } else if (!Array.isArray(parsed[0])) {
                // This is a simple data row (not nested in headers), just use it
                return { text: fullText, startLine: arrayStartLine };
            }
        }
    } catch (e) {
        console.log('extractCompleteArray: Parse error', e);
    }

    return { text: fullText, startLine: arrayStartLine };
}

/**
 * Provides inline hints for the active editor by adding decorations after each value
 * in the current data row, showing the corresponding column header.
 */
function provideHint(editor: vscode.TextEditor) {
    const doc = editor.document;

    if (doc.languageId !== 'json') {
        editor.setDecorations(decorationType, []);
        return;
    }

    const text = doc.getText();
    let root: any;
    try {
        root = parseJson(text);
    } catch (err) {
        editor.setDecorations(decorationType, []);
        return;
    }

    // Validate: array of arrays with string headers
    if (!Array.isArray(root) || root.length === 0 || !Array.isArray(root[0]) || 
        !root[0].every((s: any) => typeof s === 'string')) {
        editor.setDecorations(decorationType, []);
        return;
    }

    // Get current row index from cursor position
    const cursorPos = editor.selection.active;
    const cursorOffset = doc.offsetAt(cursorPos);
    const cursorLoc = getLocation(text, Math.max(0, cursorOffset - 1));
    
    console.log('DEBUG: cursorOffset:', cursorOffset, 'cursorLoc.path:', cursorLoc.path);
    
    let rowIdx = -1;
    
    // Extract row index - be strict: must be inside a data row array element
    if (Array.isArray(cursorLoc.path) && cursorLoc.path.length >= 1 && typeof cursorLoc.path[0] === 'number') {
        rowIdx = cursorLoc.path[0] as number;
    }

    console.log('DEBUG: rowIdx:', rowIdx, 'root.length:', root.length);

    // Only process data rows (skip header at index 0)
    if (rowIdx < 1 || rowIdx >= root.length) {
        console.log('DEBUG: RowIdx out of range:', rowIdx);
        editor.setDecorations(decorationType, []);
        return;
    }

    const headers = root[0] as string[];
    const currentRow = root[rowIdx];
    if (!Array.isArray(currentRow)) {
        editor.setDecorations(decorationType, []);
        return;
    }

    const decorations: vscode.DecorationOptions[] = [];

    // Find the exact text range of the current data row by bracket matching
    // This ensures we only search within the current row, not nested arrays
    let rowArrayStart = -1;
    let rowArrayEnd = -1;
    
    // Search backward from cursor to find the opening [ of current row
    let bracketDepth = 0;
    for (let i = cursorOffset - 1; i >= 0; i--) {
        if (text[i] === ']') {
            bracketDepth++;
        } else if (text[i] === '[') {
            if (bracketDepth === 0) {
                rowArrayStart = i;
                break;
            }
            bracketDepth--;
        }
    }
    
    // Search forward from cursor to find the closing ] of current row
    bracketDepth = 0;
    for (let i = cursorOffset; i < text.length; i++) {
        if (text[i] === '[') {
            bracketDepth++;
        } else if (text[i] === ']') {
            if (bracketDepth === 0) {
                rowArrayEnd = i;
                break;
            }
            bracketDepth--;
        }
    }
    
    if (rowArrayStart === -1 || rowArrayEnd === -1) {
        editor.setDecorations(decorationType, []);
        return;
    }

    // Extract only the current row's text for searching
    const rowText = text.substring(rowArrayStart, rowArrayEnd + 1);

    // For each column, find the value using fast text search within row scope only
    let searchStartInRow = 0;
    for (let colIdx = 0; colIdx < headers.length; colIdx++) {
        const value = currentRow[colIdx];
        
        // Build search pattern based on value type
        let searchPattern: string;
        if (typeof value === 'string') {
            searchPattern = JSON.stringify(value);  // e.g., "hello"
        } else if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
            searchPattern = String(value);  // e.g., 123, true, null
        } else {
            // For arrays/objects, use JSON string (e.g., [], {}, [1,2,3])
            searchPattern = JSON.stringify(value);
        }
        
        // Search from previous position within row scope
        const index = rowText.indexOf(searchPattern, searchStartInRow);
        if (index === -1) {
            continue;
        }
        
        let valueStart = rowArrayStart + index;
        searchStartInRow = index + searchPattern.length;  // Next search starts after this value
        
        // Found start of value, now find the end by parsing the value
        let valueEnd = valueStart;
        const ch = text[valueStart];
        
        if (ch === '"') {
            // String: scan until closing quote
            valueEnd = valueStart + 1;
            let escaped = false;
            while (valueEnd < text.length) {
                if (escaped) {
                    escaped = false;
                } else if (text[valueEnd] === '\\') {
                    escaped = true;
                } else if (text[valueEnd] === '"') {
                    break;
                }
                valueEnd++;
            }
        } else if (ch === '[') {
            // Array: scan until matching ]
            let depth = 0;
            while (valueEnd < text.length) {
                if (text[valueEnd] === '[') depth++;
                else if (text[valueEnd] === ']') {
                    depth--;
                    if (depth === 0) break;
                }
                valueEnd++;
            }
        } else if (ch === '{') {
            // Object: scan until matching }
            let depth = 0;
            while (valueEnd < text.length) {
                if (text[valueEnd] === '{') depth++;
                else if (text[valueEnd] === '}') {
                    depth--;
                    if (depth === 0) break;
                }
                valueEnd++;
            }
        } else {
            // Number/boolean/null: scan until delimiter
            while (valueEnd < text.length && 
                   text[valueEnd] !== ',' && 
                   text[valueEnd] !== ']' && 
                   text[valueEnd] !== '}' && 
                   text[valueEnd] !== ' ' && 
                   text[valueEnd] !== '\t' && 
                   text[valueEnd] !== '\n' && 
                   text[valueEnd] !== '\r') {
                valueEnd++;
            }
            valueEnd--;
        }
        
        try {
            const startPos = doc.positionAt(valueStart);
            const endPos = doc.positionAt(valueEnd + 1);
            
            // Skip if crosses lines
            if (startPos.line !== endPos.line) {
                continue;
            }
            
            const range = new vscode.Range(startPos, endPos);
            decorations.push({
                range: range,
                renderOptions: {
                    after: {
                        contentText: ` ${headers[colIdx]}`,
                        color: 'rgba(128,128,128,0.6)'
                    }
                }
            });
        } catch (e) {
            continue;
        }
    }

    console.log('DEBUG: Setting', decorations.length, 'decorations for rowIdx', rowIdx);
    editor.setDecorations(decorationType, decorations);
}

/**
 * Parses a JSON array line to find all leaf elements (values) and their positions.
 * Returns ranges for each value that should get a hint, along with the column index.
 * For multi-line text, returns line and column positions relative to the start.
 */
function getLeafRanges(lineText: string, headers: string[], isMultiLine: boolean): {line: number, startCol: number, endCol: number, col: number}[] {
    const leaves: {line: number, startCol: number, endCol: number, col: number}[] = [];
    let i = 0;
    let currentLine = 0;
    let currentCol = 0;

    // Skip to [
    while (i < lineText.length && lineText[i] !== '[') {
        if (lineText[i] === '\n') {
            currentLine++;
            currentCol = 0;
        } else {
            currentCol++;
        }
        i++;
    }
    if (i >= lineText.length) return leaves;
    i++; // Skip [
    if (isMultiLine) currentCol++; else currentCol = 1; // Adjust for [

    let col = 0;
    while (i < lineText.length && lineText[i] !== ']') {
        // Skip whitespace
        while (i < lineText.length && (lineText[i] === ' ' || lineText[i] === '\t' || lineText[i] === '\n')) {
            if (lineText[i] === '\n') {
                currentLine++;
                currentCol = 0;
            } else {
                currentCol++;
            }
            i++;
        }
        if (i >= lineText.length || lineText[i] === ']') break;
        if (lineText[i] === ',') {
            i++;
            currentCol++;
            continue;
        }
        const startLine = currentLine;
        const startCol = currentCol;
        i = parseValue(lineText, i, headers, col, leaves, isMultiLine, startLine, startCol);
        col++;
    }
    return leaves;
}

/**
 * Parses a nested array within the line, adding leaf elements to the results.
 * All elements in a nested array belong to the same column.
 */
function parseArray(text: string, startIdx: number, headers: string[], col: number, leaves: {line: number, startCol: number, endCol: number, col: number}[], isMultiLine: boolean, startLine: number, startCol: number): number {
    let i = startIdx;
    let currentLine = startLine;
    let currentCol = startCol;

    // Skip to [
    while (i < text.length && text[i] !== '[') {
        if (text[i] === '\n') {
            currentLine++;
            currentCol = 0;
        } else {
            currentCol++;
        }
        i++;
    }
    if (i >= text.length) return i;
    i++; // Skip [
    currentCol++;

    while (i < text.length && text[i] !== ']') {
        // Skip whitespace
        while (i < text.length && (text[i] === ' ' || text[i] === '\t' || text[i] === '\n')) {
            if (text[i] === '\n') {
                currentLine++;
                currentCol = 0;
            } else {
                currentCol++;
            }
            i++;
        }
        if (i >= text.length || text[i] === ']') break;
        if (text[i] === ',') {
            i++;
            currentCol++;
            continue;
        }
        i = parseValue(text, i, headers, col, leaves, isMultiLine, currentLine, currentCol);
    }
    return i + 1; // Skip ]
}

/**
 * Parses a single value (string, number, or array) and adds it to the leaves list.
 * Handles strings with escape sequences and nested arrays.
 */
function parseValue(text: string, startIdx: number, headers: string[], col: number, leaves: {line: number, startCol: number, endCol: number, col: number}[], isMultiLine: boolean, startLine: number, startCol: number): number {
    let i = startIdx;
    let currentLine = startLine;
    let currentCol = startCol;

    // Skip whitespace
    while (i < text.length && (text[i] === ' ' || text[i] === '\t' || text[i] === '\n')) {
        if (text[i] === '\n') {
            currentLine++;
            currentCol = 0;
        } else {
            currentCol++;
        }
        i++;
    }
    if (i >= text.length) return i;

    const valueStartLine = currentLine;
    const valueStartCol = currentCol;

    if (text[i] === '"') {
        // Parse string value
        i++; // Skip opening quote
        currentCol++;
        while (i < text.length && text[i] !== '"') {
            if (text[i] === '\\') {
                i += 2;
                currentCol += 2;
            } else {
                i++;
                currentCol++;
            }
        }
        i++; // Skip closing quote
        currentCol++;
        leaves.push({line: valueStartLine, startCol: valueStartCol, endCol: currentCol - 1, col});
    } else if (text[i] === '[') {
        // Parse nested array
        i = parseArray(text, i, headers, col, leaves, isMultiLine, currentLine, currentCol);
    } else {
        // Parse number or other primitive
        while (i < text.length && text[i] !== ',' && text[i] !== ']' && text[i] !== ' ' && text[i] !== '\n') {
            i++;
            currentCol++;
        }
        leaves.push({line: valueStartLine, startCol: valueStartCol, endCol: currentCol - 1, col});
    }
    return i;
}
