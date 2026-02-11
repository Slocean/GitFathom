# GitFathom

A lightweight VS Code extension that generates git commit messages from repository changes and places the message into the Source Control input box.

## Features

- Adds two buttons in Git Source Control title area:
  - `Open Setup Wizard`
  - `AI: Generate Commit Message`
- Supports providers:
  - OpenAI
  - DeepSeek
  - Gemini
  - Kimi (Moonshot)
  - GLM (Zhipu)
  - Custom OpenAI-compatible providers
- Supports third-party gateways/proxies:
  - custom `baseUrl`
  - custom request path
  - extra headers JSON
- Built-in setup wizard to configure language, provider, model, API key, base URL, request path, and headers.
- Supports language switch (`zh` / `en`) for UI and commit output language.
- Performance-focused defaults:
  - bounded git diff size (`maxDiffBytes`)
  - command and request timeouts
  - no background polling

## Setup

1. Install dependencies:

   ```bash
   npm install
   ```

2. Compile:

   ```bash
   npm run compile
   ```

3. Press `F5` to launch the Extension Development Host.

## Quick Start

1. Press `F1` -> run `GitFathom: Open Setup Wizard`.
2. Select language, provider, and model.
3. Configure API key / base URL / headers if needed.
4. Open a git repository, then click `AI: Generate Commit Message` in Source Control.

## Important Settings

- `autogitllm.language`: `zh | en`
- `autogitllm.provider`: `openai | deepseek | gemini | kimi | glm | custom`
- `autogitllm.model`
- `autogitllm.apiKey`
- `autogitllm.baseUrl`
- `autogitllm.customRequestPath`
- `autogitllm.extraHeaders`
- `autogitllm.ruleTemplate`
- `autogitllm.additionalRules`

## Environment Variables

If `autogitllm.apiKey` is empty, the extension checks:

- `OPENAI_API_KEY`
- `DEEPSEEK_API_KEY`
- `GEMINI_API_KEY`
- `MOONSHOT_API_KEY`
- `ZHIPU_API_KEY`
- `AUTOGITLLM_API_KEY`
