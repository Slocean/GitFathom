import * as vscode from "vscode";
import { ExtensionConfig, Provider, UiLanguage } from "./types";

const DEFAULT_BASE_URLS: Record<Exclude<Provider, "custom">, string> = {
  openai: "https://api.openai.com/v1",
  deepseek: "https://api.deepseek.com/v1",
  gemini: "https://generativelanguage.googleapis.com",
  kimi: "https://api.moonshot.cn/v1",
  glm: "https://open.bigmodel.cn/api/paas/v4"
};

const DEFAULT_MODELS: Record<Provider, string> = {
  openai: "gpt-4o-mini",
  deepseek: "deepseek-chat",
  gemini: "gemini-2.0-flash",
  kimi: "moonshot-v1-8k",
  glm: "glm-4-flash",
  custom: "gpt-4o-mini"
};

const PROVIDER_ENV_KEYS: Record<Provider, string> = {
  openai: "OPENAI_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
  gemini: "GEMINI_API_KEY",
  kimi: "MOONSHOT_API_KEY",
  glm: "ZHIPU_API_KEY",
  custom: "AUTOGITLLM_API_KEY"
};

const DEFAULT_PROMPTS: Record<UiLanguage, { system: string; rule: string }> = {
  zh: {
    system: "你是一名资深软件工程师，擅长撰写简洁、高质量的 Git 提交信息。",
    rule: "只生成一行提交信息，使用 Conventional Commits 格式：<type>(可选scope): <subject>。长度不超过72字符，使用祈使语气，不要句号，不要输出多余内容。"
  },
  en: {
    system: "You are an expert software engineer who writes concise and high-quality git commit messages.",
    rule: "Generate exactly one git commit message line using Conventional Commits format: <type>(optional-scope): <subject>. Keep it <= 72 characters, imperative mood, no trailing period, and output only the message."
  }
};

export function readConfig(): ExtensionConfig {
  const cfg = vscode.workspace.getConfiguration("autogitllm");
  const provider = cfg.get<Provider>("provider", "openai");
  const language = normalizeLanguage(cfg.get<string>("language", "zh"));
  const rawModel = cfg.get<string>("model", "").trim();
  const rawSystemPrompt = cfg.get<string>("systemPrompt", "").trim();
  const rawRuleTemplate = cfg.get<string>("ruleTemplate", "").trim();

  return {
    language,
    provider,
    model: rawModel || DEFAULT_MODELS[provider],
    apiKey: resolveApiKey(provider, cfg.get<string>("apiKey", "").trim()),
    baseUrl: cfg.get<string>("baseUrl", "").trim(),
    customRequestPath: ensureLeadingSlash(cfg.get<string>("customRequestPath", "/chat/completions")),
    extraHeaders: parseHeaders(cfg.get<string>("extraHeaders", "{}")),
    temperature: clamp(cfg.get<number>("temperature", 0.2), 0, 2),
    maxTokens: Math.max(16, Math.floor(cfg.get<number>("maxTokens", 120))),
    requestTimeoutMs: Math.max(3000, Math.floor(cfg.get<number>("requestTimeoutMs", 25000))),
    commandTimeoutMs: Math.max(3000, Math.floor(cfg.get<number>("commandTimeoutMs", 12000))),
    includeOnlyStaged: cfg.get<boolean>("includeOnlyStaged", false),
    maxDiffBytes: Math.max(4096, Math.floor(cfg.get<number>("maxDiffBytes", 120000))),
    systemPrompt: rawSystemPrompt || DEFAULT_PROMPTS[language].system,
    ruleTemplate: rawRuleTemplate || DEFAULT_PROMPTS[language].rule,
    additionalRules: cfg.get<string>("additionalRules", ""),
    copyToClipboard: cfg.get<boolean>("copyToClipboard", false)
  };
}

export function resolveBaseUrl(config: ExtensionConfig): string {
  if (config.baseUrl) {
    return stripTrailingSlashes(config.baseUrl);
  }

  if (config.provider === "custom") {
    return "";
  }

  return DEFAULT_BASE_URLS[config.provider];
}

export function getDefaultModel(provider: Provider): string {
  return DEFAULT_MODELS[provider];
}

export function normalizeLanguage(value: string | undefined): UiLanguage {
  return value === "en" ? "en" : "zh";
}

function resolveApiKey(provider: Provider, configuredKey: string): string {
  if (configuredKey) {
    return configuredKey;
  }

  const providerKey = process.env[PROVIDER_ENV_KEYS[provider]]?.trim();
  if (providerKey) {
    return providerKey;
  }

  return process.env.AUTOGITLLM_API_KEY?.trim() ?? "";
}

function parseHeaders(raw: string): Record<string, string> {
  const trimmed = raw.trim();
  if (!trimmed) {
    return {};
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }

    const output: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "string") {
        output[key] = value;
      }
    }

    return output;
  } catch {
    return {};
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function ensureLeadingSlash(value: string): string {
  if (!value) {
    return "/chat/completions";
  }
  return value.startsWith("/") ? value : `/${value}`;
}

function stripTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, "");
}
