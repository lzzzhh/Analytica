import type {
	ApiKeyCredential,
	AuthContext,
	AuthResult,
	Model,
	Provider,
	ProviderStreamOptions,
	RefreshModelsContext,
} from "@earendil-works/pi-ai";
import { stream, streamSimple } from "@earendil-works/pi-ai/compat";
import { LlamaClient, type LlamaModelInfo, llamaInferenceUrl, normalizeLlamaServerUrl } from "./client.ts";

export const LLAMA_PROVIDER_ID = "llama.cpp";
export const DEFAULT_LLAMA_SERVER_URL = "http://127.0.0.1:8080";
function credentialServerUrl(credential: ApiKeyCredential | undefined): string | undefined {
	const value = credential?.env?.LLAMA_BASE_URL;
	return typeof value === "string" && value.trim() ? normalizeLlamaServerUrl(value) : undefined;
}

async function resolveServerUrl(
	ctx: AuthContext,
	credential: ApiKeyCredential | undefined,
): Promise<string | undefined> {
	const configured = credentialServerUrl(credential) ?? (await ctx.env("LLAMA_BASE_URL"))?.trim();
	return configured ? normalizeLlamaServerUrl(configured) : undefined;
}

function toPiModel(model: LlamaModelInfo, serverUrl: string): Model<"openai-completions"> {
	// Prefer n_ctx_train (model capability) over n_ctx (current runtime slot size).
	// n_ctx is limited by the -c flag at server start, but Pi's token budget
	// clamping uses contextWindow to compute the max output tokens. Using the
	// small runtime value caused max_tokens to clamp to 1 for long system prompts.
	const reportedContextWindow = model.meta?.n_ctx_train ?? model.meta?.n_ctx;
	const contextWindow = reportedContextWindow && reportedContextWindow > 0 ? reportedContextWindow : 128000;
	return {
		id: model.id,
		name: model.id,
		api: "openai-completions",
		provider: LLAMA_PROVIDER_ID,
		baseUrl: llamaInferenceUrl(serverUrl),
		reasoning: false,
		input: model.architecture?.input_modalities?.includes("image") ? ["text", "image"] : ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow,
		maxTokens: contextWindow,
		compat: {
			supportsStore: false,
			supportsDeveloperRole: false,
			supportsReasoningEffort: false,
			supportsUsageInStreaming: true,
			supportsStrictMode: false,
			maxTokensField: "max_tokens",
		},
	};
}

export interface LlamaProviderController {
	provider: Provider<"openai-completions">;
	setCatalog(models: readonly LlamaModelInfo[], serverUrl: string): void;
}

export function createLlamaProvider(): LlamaProviderController {
	let models: readonly Model<"openai-completions">[] = [];

	const setCatalog = (catalog: readonly LlamaModelInfo[], serverUrl: string): void => {
		// Include ALL models (not just loaded) so CLI mode can discover them.
		// Auto-load happens on first stream call if needed.
		models = catalog.map((model) => toPiModel(model, serverUrl));
	};

	const provider: Provider<"openai-completions"> = {
		id: LLAMA_PROVIDER_ID,
		name: "llama.cpp",
		baseUrl: llamaInferenceUrl(DEFAULT_LLAMA_SERVER_URL),
		auth: {
			apiKey: {
				name: "llama.cpp server",
				login: async (interaction): Promise<ApiKeyCredential> => {
					const enteredUrl = await interaction.prompt({
						type: "text",
						message: "llama.cpp server URL",
						placeholder: process.env.LLAMA_BASE_URL ?? DEFAULT_LLAMA_SERVER_URL,
					});
					const serverUrl = normalizeLlamaServerUrl(
						enteredUrl.trim() || process.env.LLAMA_BASE_URL || DEFAULT_LLAMA_SERVER_URL,
					);
					const apiKey = (
						await interaction.prompt({
							type: "secret",
							message: "API key (optional)",
						})
					).trim();
					await new LlamaClient(serverUrl, apiKey || undefined).list({ signal: interaction.signal });
					return {
						type: "api_key",
						key: apiKey || undefined,
						env: { LLAMA_BASE_URL: serverUrl },
					};
				},
				check: async ({ ctx, credential }) => {
					const serverUrl = await resolveServerUrl(ctx, credential);
					return serverUrl
						? { type: "api_key", source: credential ? "stored credential" : "LLAMA_BASE_URL" }
						: undefined;
				},
				resolve: async ({ ctx, credential }): Promise<AuthResult | undefined> => {
					const serverUrl = await resolveServerUrl(ctx, credential);
					if (!serverUrl) return undefined;
					const apiKey = credential?.key ?? (await ctx.env("LLAMA_API_KEY")) ?? "local";
					return {
						auth: { apiKey, baseUrl: llamaInferenceUrl(serverUrl) },
						env: { ...credential?.env, LLAMA_BASE_URL: serverUrl },
						source: credential ? "stored credential" : "LLAMA_BASE_URL",
					};
				},
			},
		},
		getModels: () => models,
		refreshModels: async (context: RefreshModelsContext): Promise<void> => {
			const stored = await context.store.read();
			if (stored) {
				models = stored.models.filter(
					(model): model is Model<"openai-completions"> =>
						model.provider === LLAMA_PROVIDER_ID && model.api === "openai-completions",
				);
			}

			if (context.signal?.aborted || context.credential?.type !== "api_key") return;
			const serverUrl = credentialServerUrl(context.credential);
			if (!serverUrl) return;
			// Always allow network for localhost (safe, no external API calls)
			const isLocalhost = serverUrl.includes("127.0.0.1") || serverUrl.includes("localhost");
			if (!context.allowNetwork && !isLocalhost) return;
			const client = new LlamaClient(serverUrl, context.credential.key);
			const catalog = await client.list({ signal: context.signal });

			// Auto-load first available unloaded model (CLI mode convenience)
			const firstUnloaded = catalog.find(
				(m) => m.status.value !== "loaded" && m.status.value !== "sleeping" && m.status.value !== "loading",
			);
			if (firstUnloaded) {
				try {
					await client.load(firstUnloaded.id, context.signal);
					// Wait briefly for the model to become ready
					for (let i = 0; i < 60 && !context.signal?.aborted; i++) {
						const updated = await client.list({ signal: context.signal });
						const entry = updated.find((m) => m.id === firstUnloaded.id);
						if (entry?.status.value === "loaded" || entry?.status.value === "sleeping") break;
						if (entry?.status.failed) break;
						await new Promise((r) => setTimeout(r, 500));
					}
				} catch {
					// If auto-load fails, continue with whatever is available
				}
				const refreshed = await client.list({ signal: context.signal });
				setCatalog(refreshed, serverUrl);
			} else {
				setCatalog(catalog, serverUrl);
			}

			if (!context.signal?.aborted) await context.store.write({ models, checkedAt: Date.now() });
		},
		stream: (model, context, options) => stream(model, context, options as ProviderStreamOptions | undefined),
		streamSimple: (model, context, options) => streamSimple(model, context, options),
	};

	return { provider, setCatalog };
}
