// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import * as path from 'path';
import { compileAndRunEiffelFile } from './eiffelRunner';
import { activateDebugAdapter } from './eiffelDebugAdapter';

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {
	const runCmd = vscode.commands.registerCommand('gobo-eiffel.compileAndRunEiffelFile', async () => {
		const editor = vscode.window.activeTextEditor;
		if (!editor) {
			vscode.window.showErrorMessage('No active editor');
			return;
		}
		const doc = editor.document;
		if (doc.languageId !== 'eiffel') {
			vscode.window.showErrorMessage('This is not an Eiffel file');
			return;
		}
		const filePath = doc.fileName;
		await compileAndRunEiffelFile(filePath, path.dirname(filePath), context);
	});
	context.subscriptions.push(runCmd);

	// Activate our debug adapter logic for the Run button
	activateDebugAdapter(context);
}

// This method is called when your extension is deactivated
export function deactivate() {}
