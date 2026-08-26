import type { GenerationProtection } from "../shared/generation.shared";

export interface GenerationProviderSelection {
  provider: string;
  model: string;
  thinkingOptionId?: string | null;
}

export interface GenerationAgentPolicy {
  config: {
    provider: string;
    modeId?: string;
    thinkingOptionId?: string;
    options?: Record<string, unknown>;
    systemPrompt: string;
  };
  protection: GenerationProtection;
}

const COMMON_TOOL_DENYLIST = [
  "Bash",
  "Edit",
  "Write",
  "NotebookEdit",
  "WebFetch",
  "WebSearch",
  "Task",
];

function normalizedProvider(provider: string): string {
  return provider.trim().toLocaleLowerCase("en-US");
}

function joinedProvider(selection: GenerationProviderSelection): string {
  const provider = selection.provider.trim();
  const model = selection.model.trim();
  if (!provider || provider.includes("/")) throw new Error("Expected a provider id without a model suffix");
  if (!model) throw new Error("A generation model is required");
  return `${provider}/${model}`;
}

/**
 * Builds the strongest unattended, read-only launch configuration exposed by
 * Paseo 0.5.1 for the selected provider. These settings are defense in depth;
 * the provider CLI still runs as the daemon OS user and is not a host boundary.
 */
export function buildGenerationAgentPolicy(input: {
  selection: GenerationProviderSelection;
  allowProjectRead: boolean;
  projectRoot: string;
  vaultRoot: string;
  systemPrompt: string;
}): GenerationAgentPolicy {
  const provider = normalizedProvider(input.selection.provider);
  const baseConfig = {
    provider: joinedProvider(input.selection),
    ...(input.selection.thinkingOptionId
      ? { thinkingOptionId: input.selection.thinkingOptionId }
      : {}),
    systemPrompt: input.systemPrompt,
  };

  if (provider === "codex") {
    return {
      config: {
        ...baseConfig,
        options: {
          approval_policy: "never",
          sandbox_mode: "read-only",
          web_search: "disabled",
          features: {
            multi_agent_v2: false,
            network_proxy: false,
          },
        },
      },
      protection: {
        level: "behavioral-only",
        projectRead: input.allowProjectRead,
        warning: null,
      },
    };
  }

  if (provider === "kimi") {
    return {
      config: {
        ...baseConfig,
        modeId: input.allowProjectRead ? "default" : "plan",
      },
      protection: {
        level: input.allowProjectRead ? "behavioral-only" : "native-policy",
        projectRead: input.allowProjectRead,
        warning: null,
      },
    };
  }

  if (provider === "claude") {
    const disallowedTools = input.allowProjectRead
      ? COMMON_TOOL_DENYLIST
      : [...COMMON_TOOL_DENYLIST, "Read", "Glob", "Grep"];
    return {
      config: {
        ...baseConfig,
        options: {
          ...(input.allowProjectRead ? { allowedTools: ["Read", "Glob", "Grep"] } : {}),
          disallowedTools,
          sandbox: {
            enabled: true,
            failIfUnavailable: true,
            allowUnsandboxedCommands: false,
            filesystem: {
              allowRead: input.allowProjectRead ? [input.projectRoot] : [],
              denyRead: input.allowProjectRead ? [input.vaultRoot] : [input.projectRoot, input.vaultRoot],
              denyWrite: [input.projectRoot, input.vaultRoot],
            },
            network: {
              allowedDomains: [],
              strictAllowlist: true,
            },
          },
        },
      },
      protection: {
        level: "behavioral-only",
        projectRead: input.allowProjectRead,
        warning: null,
      },
    };
  }

  if (provider === "opencode") {
    return {
      config: {
        ...baseConfig,
        options: {
          permission: input.allowProjectRead
            ? {
                read: "allow",
                glob: "allow",
                grep: "allow",
                list: "allow",
                edit: "deny",
                bash: "deny",
                task: "deny",
                external_directory: "deny",
                repo_clone: "deny",
                repo_overview: "deny",
                lsp: "deny",
                skill: "deny",
                todowrite: "deny",
                question: "deny",
                webfetch: "deny",
                websearch: "deny",
                codesearch: "deny",
                doom_loop: "deny",
              }
            : "deny",
        },
      },
      protection: {
        level: input.allowProjectRead ? "behavioral-only" : "native-policy",
        projectRead: input.allowProjectRead,
        warning: null,
      },
    };
  }

  return {
    config: baseConfig,
    protection: {
      level: "behavioral-only",
      projectRead: input.allowProjectRead,
      warning: null,
    },
  };
}
