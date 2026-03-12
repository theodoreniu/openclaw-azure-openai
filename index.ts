import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import fs from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PLUGIN_ID = "openclaw-azure-openai";
const PROVIDER_KEY = "azure-openai-responses";
const VERSION: string = JSON.parse(
  fs.readFileSync(path.join(__dirname, "package.json"), "utf-8"),
).version;
const PRIMARY_MODEL = `${PROVIDER_KEY}/gpt-5.4`;
const LOG_PREFIX = `[${PLUGIN_ID}]`;

function log(level: "debug" | "info" | "warn" | "error", ...args: unknown[]) {
  console[level === "debug" ? "log" : level](LOG_PREFIX, ...args);
}

// ---------------------------------------------------------------------------
// Config schema
// ---------------------------------------------------------------------------

interface AzureOpenAILoggingConfig {
  resource_name: string;
  api_key: string;
}

const azureOpenAILoggingConfigSchema = {
  parse(value: unknown): AzureOpenAILoggingConfig {
    const raw =
      value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};

    return {
      resource_name: (raw.resource_name as string) ?? "",
      api_key: (raw.api_key as string) ?? "",
    };
  },
  uiHints: {
    resource_name: {
      label: "Resource Name",
      help: "Azure OpenAI resource name (e.g. my-openai-resource)",
    },
    api_key: {
      label: "API Key",
      help: "Azure OpenAI API key",
      sensitive: true,
    },
  },
};

// ---------------------------------------------------------------------------
// Model definitions (single source of truth)
// ---------------------------------------------------------------------------

interface ModelDef {
  id: string;
  name: string;
}

const MODEL_DEFS: ModelDef[] = [
  { id: "gpt-5.3-chat", name: "GPT 5.3 Chat" },
  { id: "gpt-5.4", name: "GPT 5.4" },
  { id: "gpt-5.4-pro", name: "GPT 5.4 Pro" },
];

function buildModelEntry(def: ModelDef) {
  return {
    id: def.id,
    name: def.name,
    api: "openai-responses",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 16384,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readJsonFile(filePath: string): Record<string, any> {
  const raw = fs.readFileSync(filePath, "utf-8");
  return JSON.parse(raw);
}

function writeJsonFile(filePath: string, data: unknown): void {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

// ---------------------------------------------------------------------------
// Banner
// ---------------------------------------------------------------------------

const BANNER = [
  "",
  "    ___                              ____                    ___    ____",
  "   /   |  ____  __  __  ________    / __ \\  ____   ___     /   |  /  _/",
  "  / /| | /_  / / / / / / ___/ _ \\  / / / / / __ \\ / _ \\   / /| |  / /  ",
  " / ___ |  / /_/ /_/ / / /  /  __/ / /_/ / / /_/ //  __/  / ___ |_/ /   ",
  "/_/  |_| /___/\\__,_/ /_/   \\___/  \\____/ / .___/ \\___/  /_/  |_/___/   ",
  "                                         /_/                            ",
  "",
  `  Azure OpenAI Logging Plugin v${VERSION} - Powered by OpenClaw`,
  "",
].join("\n");

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

const azureOpenAILoggingPlugin = {
  id: PLUGIN_ID,
  name: "Azure OpenAI",
  description: "Azure OpenAI requests and responses from the gateway",
  configSchema: azureOpenAILoggingConfigSchema,

  register(api: OpenClawPluginApi) {
    const config = azureOpenAILoggingConfigSchema.parse(api.pluginConfig);

    api.on(
      "gateway_start",
      (_event, _ctx) => {
        console.log(BANNER);

        if (!config.resource_name || !config.api_key) {
          log(
            "warn",
            "Azure OpenAI resource name or API key is not set in plugin config. " +
              "Please provide them to enable logging.",
          );
          return;
        }

        // ---- Resolve paths ------------------------------------------------
        const openclawDir = path.resolve(__dirname, "..", "..");
        const configPath = path.join(openclawDir, "openclaw.json");
        const versionFilePath = path.join(__dirname, "version.lock");

        // ---- Read existing openclaw config ---------------------------------
        let openClawConfig: Record<string, any>;
        try {
          openClawConfig = readJsonFile(configPath);
        } catch (err) {
          log("error", "Failed to read openclaw.json:", err);
          return;
        }

        // ---- Determine whether models need to be (re-)written -------------
        let needSetModels = false;

        try {
          const existingVersion = fs.readFileSync(versionFilePath, "utf-8");
          if (existingVersion !== VERSION) {
            log(
              "info",
              `Version change detected (${existingVersion} -> ${VERSION}). Updating configuration…`,
            );
            needSetModels = true;
          }
        } catch {
          log("info", "No version lock found — assuming first run.");
          needSetModels = true;
        }

        const hasProvider =
          openClawConfig.models?.providers?.[PROVIDER_KEY] !== undefined;

        if (!hasProvider) {
          log("info", "Azure OpenAI provider missing from config — will add.");
          needSetModels = true;
        }

        const baseUrl = `https://${config.resource_name}.openai.azure.com/openai/v1`;
        const apiKey = config.api_key;

        // compare existing config values to avoid unnecessary writes
        if (hasProvider) {
          const existingProvider =
            openClawConfig.models.providers[PROVIDER_KEY];

          if (
            existingProvider.baseUrl !== baseUrl ||
            existingProvider.apiKey !== apiKey
          ) {
            log(
              "info",
              "Azure OpenAI provider config has changed — will update.",
            );
            needSetModels = true;
          }
        }

        // ---- Apply model / agent defaults if needed -----------------------
        if (needSetModels) {
          // Ensure nested structure exists
          openClawConfig.models ??= {};
          openClawConfig.models.providers ??= {};
          openClawConfig.agents ??= {};
          openClawConfig.agents.defaults ??= {};

          openClawConfig.agents.defaults.model ??= {};
          openClawConfig.agents.defaults.model["primary"] = PRIMARY_MODEL;

          // Provider entry
          openClawConfig.models.providers[PROVIDER_KEY] = {
            baseUrl,
            apiKey,
            api: "openai-responses",
            authHeader: false,
            models: MODEL_DEFS.map(buildModelEntry),
          };

          // Persist changes
          try {
            writeJsonFile(configPath, openClawConfig);
            log("info", "Updated openclaw.json with Azure OpenAI provider.");
          } catch (err) {
            log("error", "Failed to write openclaw.json:", err);
          }

          try {
            fs.writeFileSync(versionFilePath, VERSION);
          } catch (err) {
            log("error", "Failed to write version lock:", err);
          }
        }

        // ---- Summary log --------------------------------------------------
        const modelIds =
          openClawConfig.models.providers[PROVIDER_KEY]?.models?.map(
            (m: { id: string }) => m.id,
          ) ?? [];
        log("info", `Provider ready with models: [${modelIds.join(", ")}]`);
      },
      { priority: 1000 },
    );
  },
};

export default azureOpenAILoggingPlugin;
