import * as vscode from 'vscode';
import { AiRequestError, generateCommitText } from './ai';
import { readConfig } from './config';
import { collectRepositoryChanges, getGitApi, pickRepository } from './git';
import { providerLabel, t } from './i18n';
import { buildPrompt } from './prompt';
import { openSetupWizard } from './setupWizard';
import { AiDebugSnapshot, ExtensionConfig, GenerateCommitResult, PromptPayload, UiLanguage } from './types';

interface SetupIssueAction {
  kind: 'setup' | 'setting';
  label: string;
  setting?: string;
}

interface SetupIssue {
  message: string;
  actions: SetupIssueAction[];
}

interface LastDebugState {
  prompt: PromptPayload;
  snapshot: AiDebugSnapshot;
}

let lastDebugState: LastDebugState | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const generateDisposable = vscode.commands.registerCommand(
    'gitgathom.generateCommitMessage',
    async (scmContext?: unknown) => {
      await runGenerateCommitMessage(scmContext);
    }
  );

  const setupDisposable = vscode.commands.registerCommand('gitgathom.openSetup', async () => {
    await runSetupWizard();
  });

  const debugDisposable = vscode.commands.registerCommand('gitgathom.showLastDebugReport', async () => {
    await showLastDebugReport();
  });

  context.subscriptions.push(generateDisposable, setupDisposable, debugDisposable);
}

export function deactivate(): void {
  // No resources to dispose.
}

async function runGenerateCommitMessage(scmContext?: unknown): Promise<void> {
  const config = readConfig();

  try {
    const setupIssue = getSetupIssue(config);
    if (setupIssue) {
      await promptForSetup(config.language, setupIssue);
      return;
    }

    const gitApi = await getGitApi();

    if (!gitApi) {
      vscode.window.showErrorMessage(t(config.language, 'gitUnavailable'));
      return;
    }

    const repository = pickRepository(gitApi.repositories, scmContext);
    if (!repository) {
      vscode.window.showErrorMessage(t(config.language, 'noRepo'));
      return;
    }

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: t(config.language, 'progressTitle'),
        cancellable: false
      },
      async () => {
        const snapshot = await collectRepositoryChanges(repository.rootUri.fsPath, config);
        if (!snapshot.status.trim()) {
          vscode.window.showInformationMessage(t(config.language, 'noChanges'));
          return;
        }

        const prompt = buildPrompt(snapshot, config);
        let result: GenerateCommitResult;

        try {
          result = await generateCommitText(prompt, config);
        } catch (error) {
          if (error instanceof AiRequestError) {
            lastDebugState = {
              prompt,
              snapshot: error.debug
            };

            if (config.debugView) {
              await openDebugDocument(lastDebugState);
            }
          }

          throw error;
        }

        const commitMessage = result.commitMessage;

        lastDebugState = {
          prompt,
          snapshot: result.debug
        };

        repository.inputBox.value = commitMessage;

        if (config.copyToClipboard) {
          await vscode.env.clipboard.writeText(commitMessage);
        }

        if (config.debugView) {
          await openDebugDocument({
            prompt,
            snapshot: result.debug
          });
        }

        vscode.window.showInformationMessage(t(config.language, 'generated'));
      }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    vscode.window.showErrorMessage(`${t(config.language, 'failedPrefix')}${message}`);
  }
}

async function showLastDebugReport(): Promise<void> {
  if (!lastDebugState) {
    vscode.window.showInformationMessage('No AI debug report yet. Generate a commit message first.');
    return;
  }

  await openDebugDocument(lastDebugState);
}

async function openDebugDocument(state: LastDebugState): Promise<void> {
  const content = renderDebugReport(state);
  const document = await vscode.workspace.openTextDocument({
    language: 'markdown',
    content
  });

  await vscode.window.showTextDocument(document, {
    preview: false,
    preserveFocus: false
  });
}

function renderDebugReport(state: LastDebugState): string {
  const lines: string[] = [];
  const { prompt, snapshot } = state;

  lines.push('# GitFathom AI Debug Report');
  lines.push('');
  lines.push(`- Time: ${snapshot.createdAt}`);
  lines.push(`- Provider: ${snapshot.provider}`);
  lines.push(`- Model: ${snapshot.model}`);
  lines.push(`- Endpoint: ${snapshot.endpoint}`);
  lines.push(`- HTTP Status: ${snapshot.responseStatus ?? '(no response)'}`);
  lines.push('');
  lines.push('## Prompt Input');
  lines.push('### systemPrompt');
  lines.push('```text');
  lines.push(prompt.systemPrompt || '(empty)');
  lines.push('```');
  lines.push('');
  lines.push('### userPrompt');
  lines.push('```text');
  lines.push(prompt.userPrompt || '(empty)');
  lines.push('```');
  lines.push('');
  lines.push('## Request');
  lines.push('### Headers');
  lines.push('```json');
  lines.push(JSON.stringify(snapshot.requestHeaders ?? {}, null, 2));
  lines.push('```');
  lines.push('');
  lines.push('### Body');
  lines.push('```json');
  lines.push(JSON.stringify(snapshot.requestBody ?? {}, null, 2));
  lines.push('```');
  lines.push('');
  lines.push('## Response');
  lines.push('### Headers');
  lines.push('```json');
  lines.push(JSON.stringify(snapshot.responseHeaders ?? {}, null, 2));
  lines.push('```');
  lines.push('');
  lines.push('### Raw Body');
  lines.push('```json');
  lines.push(snapshot.responseBody || '(empty)');
  lines.push('```');
  lines.push('');
  lines.push('### Extracted Text');
  lines.push('```text');
  lines.push(snapshot.extractedText || '(empty)');
  lines.push('```');
  lines.push('');
  lines.push('### Final Commit Message');
  lines.push('```text');
  lines.push(snapshot.normalizedCommitMessage || '(not produced)');
  lines.push('```');

  if (snapshot.error) {
    lines.push('');
    lines.push('### Error');
    lines.push('```text');
    lines.push(snapshot.error);
    lines.push('```');
  }

  return lines.join('\n');
}

async function runSetupWizard(): Promise<void> {
  const before = readConfig().language;
  const saved = await openSetupWizard(before);
  const after = readConfig().language;

  if (saved) {
    vscode.window.showInformationMessage(t(after, 'wizardSaved'));
    return;
  }

  vscode.window.showInformationMessage(t(after, 'wizardCancelled'));
}

function getSetupIssue(config: ExtensionConfig): SetupIssue | undefined {
  const provider = providerLabel(config.language, config.provider);

  if (config.provider === 'custom' && !config.baseUrl.trim()) {
    return {
      message: t(config.language, 'setupMissingBaseUrl', { provider }),
      actions: [
        { kind: 'setup', label: t(config.language, 'actionOpenSetup') },
        { kind: 'setting', label: t(config.language, 'actionOpenSettings'), setting: 'gitgathom' },
        { kind: 'setting', label: t(config.language, 'actionConfigureBaseUrl'), setting: 'gitgathom.baseUrl' },
        { kind: 'setting', label: t(config.language, 'actionConfigureProvider'), setting: 'gitgathom.provider' }
      ]
    };
  }

  const hasCredential =
    config.provider === 'gemini'
      ? Boolean(config.apiKey)
      : Boolean(config.apiKey) ||
        hasHeader(config.extraHeaders, 'authorization') ||
        hasHeader(config.extraHeaders, 'x-api-key');

  if (!hasCredential) {
    return {
      message: t(config.language, 'setupMissingCredential', { provider }),
      actions: [
        { kind: 'setup', label: t(config.language, 'actionOpenSetup') },
        { kind: 'setting', label: t(config.language, 'actionOpenSettings'), setting: 'gitgathom' },
        { kind: 'setting', label: t(config.language, 'actionConfigureApiKey'), setting: 'gitgathom.apiKey' },
        { kind: 'setting', label: t(config.language, 'actionConfigureHeaders'), setting: 'gitgathom.extraHeaders' }
      ]
    };
  }

  return undefined;
}

async function promptForSetup(language: UiLanguage, issue: SetupIssue): Promise<void> {
  const selected = await vscode.window.showWarningMessage(
    issue.message,
    ...issue.actions.map(action => action.label)
  );
  const target = issue.actions.find(action => action.label === selected);

  if (!target) {
    return;
  }

  if (target.kind === 'setup') {
    await runSetupWizard();
    return;
  }

  if (target.setting) {
    await vscode.commands.executeCommand('workbench.action.openSettings', target.setting);
    return;
  }

  await vscode.commands.executeCommand('workbench.action.openSettings', 'gitgathom');
}

function hasHeader(headers: Record<string, string>, keyToFind: string): boolean {
  const target = keyToFind.toLowerCase();
  return Object.keys(headers).some(key => key.toLowerCase() === target);
}
