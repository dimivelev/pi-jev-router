import type { Api, Model } from "@earendil-works/pi-ai";
import type { BeforeAgentStartEvent, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { classifyTask, type JevBackend, type ModelTier } from "./policy.ts";
import {
	loadRouterSettings,
	normalizeRouterSettings,
	saveRouterSettings,
	settingsFilePath,
	validateCustomEndpoint,
	type RouterSettings,
	type ZenJevModel,
} from "./router-settings.ts";

const DEFAULT_CHEAP_MODEL = "opencode-go/deepseek-v4-flash";
const DEFAULT_EXPENSIVE_MODEL = "openai-codex/gpt-6-astra";
const DEFAULT_CONFIDENCE = 0.8;
const MAX_PROMPT_CHARS = 12_000;
const JEV_TIMEOUT_MS = 6_000;

type TierModels = Record<ModelTier, Model<Api>>;
interface JevApiConfig {
	backend: JevBackend;
	label: string;
	endpoint?: string;
	model: string;
	envKeyName: string;
	keyRequired: boolean;
}

function configuredModelRefs(settings: RouterSettings): Record<ModelTier, string> {
	return {
		cheap: settings.cheapModel || process.env.JEV_ROUTER_CHEAP_MODEL?.trim() || DEFAULT_CHEAP_MODEL,
		expensive: settings.expensiveModel || process.env.JEV_ROUTER_EXPENSIVE_MODEL?.trim() || DEFAULT_EXPENSIVE_MODEL,
	};
}

function confidenceThreshold(settings: RouterSettings): number {
	if (settings.cheapConfidence !== undefined) return settings.cheapConfidence;
	const raw = process.env.JEV_ROUTER_CHEAP_CONFIDENCE;
	if (!raw) return DEFAULT_CONFIDENCE;
	const value = Number(raw);
	return Number.isFinite(value) && value >= 0 && value <= 1 ? value : DEFAULT_CONFIDENCE;
}

function apiConfig(settings: RouterSettings): JevApiConfig {
	if (settings.apiBackend === "opencode-zen") {
		return {
			backend: "opencode-zen",
			label: "OpenCode Zen",
			endpoint: "https://opencode.ai/zen/v1/systemone",
			model: settings.zenModel || "jev-1.13-free",
			envKeyName: "OPENCODE_API_KEY",
			keyRequired: true,
		};
	}
	if (settings.apiBackend === "custom") {
		return {
			backend: "custom",
			label: "Custom endpoint",
			endpoint: settings.customEndpoint,
			model: settings.customModel || "jev-latest",
			envKeyName: "JEV_ROUTER_CUSTOM_API_KEY",
			keyRequired: false,
		};
	}
	return {
		backend: "typesafe",
		label: "TypeSafe direct",
		endpoint: "https://api.typesafe.ai/v1/systemone",
		model: "jev-latest",
		envKeyName: "TYPESAFE_API_KEY",
		keyRequired: true,
	};
}

function resolveModel(ctx: ExtensionContext, reference: string): Model<Api> {
	const separator = reference.indexOf("/");
	if (separator <= 0 || separator === reference.length - 1) {
		throw new Error(`Model must be written as provider/model-id: ${reference}`);
	}
	const provider = reference.slice(0, separator);
	const modelId = reference.slice(separator + 1);
	const model = ctx.modelRegistry.find(provider, modelId);
	if (!model) throw new Error(`Pi could not find model ${reference}`);
	if (ctx.scopedModels.length > 0 && !ctx.scopedModels.some(({ model: scoped }) => scoped.provider === provider && scoped.id === modelId)) {
		throw new Error(`${reference} is outside Pi's enabled model scope; add it to enabledModels or --models`);
	}
	if (!ctx.modelRegistry.hasConfiguredAuth(model)) {
		throw new Error(`Pi has no configured authentication for ${provider}`);
	}
	if (!model.input.includes("text")) throw new Error(`${reference} does not accept text input`);
	return model;
}

function resolveTierModels(ctx: ExtensionContext, settings: RouterSettings): TierModels {
	const refs = configuredModelRefs(settings);
	if (refs.cheap === refs.expensive) throw new Error("Cheap and expensive model settings must be different");
	return {
		cheap: resolveModel(ctx, refs.cheap),
		expensive: resolveModel(ctx, refs.expensive),
	};
}

function modelRef(model: Model<Api> | undefined): string {
	return model ? `${model.provider}/${model.id}` : "none";
}

function sameModel(left: Model<Api> | undefined, right: Model<Api> | undefined): boolean {
	return left?.provider === right?.provider && left?.id === right?.id;
}

function notify(ctx: ExtensionContext, message: string, type: "info" | "warning" | "error" = "info"): void {
	if (ctx.hasUI) ctx.ui.notify(message, type);
	else console.error(`[jev-router] ${message}`);
}

function setStatus(ctx: ExtensionContext, status: string | undefined): void {
	if (ctx.mode === "tui") ctx.ui.setStatus("jev-router", status);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function getApiKey(backend: JevBackend, config: JevApiConfig, sessionKeys: Partial<Record<JevBackend, string>>): { value: string | undefined; source: string } {
	const sessionValue = sessionKeys[backend]?.trim();
	if (sessionValue) return { value: sessionValue, source: "session-only key" };
	const envValue = process.env[config.envKeyName]?.trim();
	if (envValue) return { value: envValue, source: `environment: ${config.envKeyName}` };
	return { value: undefined, source: config.keyRequired ? `missing ${config.envKeyName}` : "no key (optional)" };
}

function availableTextModels(ctx: ExtensionContext): Model<Api>[] {
	const source = ctx.scopedModels.length > 0 ? ctx.scopedModels.map(({ model }) => model) : ctx.modelRegistry.getAvailable();
	const seen = new Set<string>();
	return source
		.filter((model) => model.input.includes("text") && ctx.modelRegistry.hasConfiguredAuth(model))
		.filter((model) => {
			const key = `${model.provider}/${model.id}`;
			if (seen.has(key)) return false;
			seen.add(key);
			return true;
		})
		.sort((a, b) => `${a.provider}/${a.id}`.localeCompare(`${b.provider}/${b.id}`));
}

function modelMenuLabels(models: Model<Api>[]): Map<string, Model<Api>> {
	return new Map(models.map((model) => [`${model.provider}/${model.id} — ${model.name}`, model]));
}

async function promptMaskedApiKey(ctx: ExtensionContext, backendLabel: string): Promise<string | undefined> {
	if (ctx.mode !== "tui") {
		notify(ctx, "Masked API-key entry is available in Pi's interactive TUI; otherwise set the provider's environment variable.", "warning");
		return undefined;
	}

	return ctx.ui.custom<string | undefined>((tui, _theme, keybindings, done) => {
		let secret = "";
		let finished = false;
		const widthText = (text: string, width: number) => text.slice(0, Math.max(0, width));
		const finish = (value: string | undefined) => {
			if (finished) return;
			finished = true;
			secret = "";
			done(value);
		};

		return {
			render(width: number) {
				const safeWidth = Math.max(1, width);
				const masked = "*".repeat(Math.min(secret.length, Math.max(0, safeWidth - 2)));
				return [
					widthText(`API key for ${backendLabel} (hidden)`, safeWidth),
					"",
					widthText(`> ${masked}`, safeWidth),
					widthText("Enter saves · Esc cancels · Backspace edits", safeWidth),
				];
			},
			handleInput(data: string) {
				if (keybindings.matches(data, "tui.select.cancel")) {
					finish(undefined);
					return;
				}
				if (keybindings.matches(data, "tui.input.submit")) {
					finish(secret.trim() || undefined);
					return;
				}
				if (keybindings.matches(data, "tui.editor.deleteCharBackward") || data === "\x7f" || data === "\b") {
					secret = Array.from(secret).slice(0, -1).join("");
					tui.requestRender();
					return;
				}
				if (keybindings.matches(data, "tui.editor.deleteToLineStart")) {
					secret = "";
					tui.requestRender();
					return;
				}
				let printable = data.replace(/^\x1b\[200~/, "").replace(/\x1b\[201~$/, "");
				if (!printable || printable.startsWith("\x1b")) return;
				printable = printable.replace(/[\u0000-\u001f\u007f]/g, "");
				if (printable) {
					secret += printable;
					tui.requestRender();
				}
			},
			invalidate() {},
			dispose() {
				secret = "";
			},
		};
	});
}

export default function jevRouterExtension(pi: ExtensionAPI): void {
	const configPath = settingsFilePath();
	let settings = loadRouterSettings(configPath);
	const sessionApiKeys: Partial<Record<JevBackend, string>> = {};
	let enabled = false;
	let baseModel: Model<Api> | undefined;
	let switchedByRouter = false;
	let changingModelInternally = false;
	let lastStatus = "ready";
	const autoStart = process.env.JEV_ROUTER_AUTO === "1";

	function updateStatus(ctx: ExtensionContext): void {
		setStatus(ctx, enabled ? `Jev auto · ${lastStatus}` : undefined);
	}

	function persistSettings(patch: RouterSettings): void {
		settings = saveRouterSettings({ ...settings, ...patch }, configPath);
	}

	function displayEndpoint(config: JevApiConfig): string {
		if (!config.endpoint) return "custom endpoint not configured";
		if (config.backend !== "custom") return config.endpoint;
		return `${new URL(config.endpoint).origin}/…/systemone`;
	}

	function formatApiStatus(): string {
		try {
			const config = apiConfig(settings);
			const key = getApiKey(config.backend, config, sessionApiKeys);
			return `${config.label} · model ${config.model} · ${displayEndpoint(config)} · key ${key.source}`;
		} catch (error) {
			return `API configuration error: ${errorMessage(error)}`;
		}
	}

	async function setModelInternally(model: Model<Api>): Promise<void> {
		changingModelInternally = true;
		try {
			const success = await pi.setModel(model);
			if (!success) throw new Error(`Pi could not activate ${modelRef(model)} (check provider authentication)`);
		} finally {
			changingModelInternally = false;
		}
	}

	async function enableRouter(ctx: ExtensionContext): Promise<void> {
		if (enabled) {
			notify(ctx, "Jev auto-routing is already on.");
			return;
		}
		const api = apiConfig(settings);
		if (api.keyRequired && !getApiKey(api.backend, api, sessionApiKeys).value) {
			throw new Error(`Set ${api.envKeyName} before starting Pi, or use the menu to enter a masked session-only key.`);
		}
		if (api.backend === "custom" && !api.endpoint) {
			throw new Error("Set a custom /systemone endpoint in /jev-router before enabling this backend.");
		}
		if (!ctx.model) throw new Error("Pi has no active model to restore when routing is turned off.");
		resolveTierModels(ctx, settings);
		baseModel = ctx.model;
		switchedByRouter = false;
		enabled = true;
		lastStatus = "ready";
		updateStatus(ctx);
		notify(ctx, `Jev auto-routing is on (${api.label}). The current task text goes to ${displayEndpoint(api)}; /jev-router off disables it.`);
	}

	async function disableRouter(ctx: ExtensionContext): Promise<void> {
		if (!enabled) {
			notify(ctx, "Jev auto-routing is already off.");
			return;
		}
		enabled = false;
		updateStatus(ctx);
		const restore = baseModel;
		baseModel = undefined;
		if (restore && !sameModel(ctx.model, restore)) {
			try {
				await setModelInternally(restore);
			} catch (error) {
				notify(ctx, `Router is off, but Pi could not restore ${modelRef(restore)}: ${errorMessage(error)}`, "warning");
				return;
			}
		}
		switchedByRouter = false;
		lastStatus = "ready";
		notify(ctx, "Jev auto-routing is off; restored your pre-router model where needed.");
	}

	async function editCustomEndpoint(ctx: ExtensionContext): Promise<boolean> {
		const current = settings.customEndpoint ? ` Configured host: ${new URL(settings.customEndpoint).origin}.` : "";
		const raw = await ctx.ui.input(`Enter a full HTTPS Jev-compatible endpoint ending in /systemone. Do not put credentials in the URL.${current}`);
		if (raw === undefined) return false;
		let endpoint: string;
		try {
			endpoint = validateCustomEndpoint(raw);
		} catch (error) {
			notify(ctx, errorMessage(error), "error");
			return false;
		}
		const origin = new URL(endpoint).origin;
		const hasKey = Boolean(getApiKey("custom", apiConfig({ ...settings, apiBackend: "custom" }), sessionApiKeys).value);
		const confirmed = await ctx.ui.confirm(
			"Trust this Jev endpoint?",
			`The current task text${hasKey ? " and custom API key" : ""} will be sent to ${origin}. Only continue if you trust this service.`,
		);
		if (!confirmed) return false;
		try {
			persistSettings({ customEndpoint: endpoint });
			notify(ctx, "Custom Jev endpoint saved without storing any API key.");
			return true;
		} catch (error) {
			notify(ctx, `Could not save router settings: ${errorMessage(error)}`, "error");
			return false;
		}
	}

	async function chooseApiBackend(ctx: ExtensionContext): Promise<void> {
		const choices = [
			"TypeSafe direct (jev-latest)",
			"OpenCode Zen (Jev 1.13; separate from Go)",
			"Custom Jev-compatible endpoint",
		];
		const selected = await ctx.ui.select("Choose Jev API backend", choices);
		if (!selected) return;
		let backend: JevBackend;
		if (selected === choices[0]) backend = "typesafe";
		else if (selected === choices[1]) {
			const confirmed = await ctx.ui.confirm(
				"OpenCode Zen billing",
				"OpenCode Zen is separate from the OpenCode Go plan; usage may be billed separately. Continue?",
			);
			if (!confirmed) return;
			backend = "opencode-zen";
		} else {
			backend = "custom";
			if (!settings.customEndpoint && !(await editCustomEndpoint(ctx))) return;
		}
		try {
			persistSettings({ apiBackend: backend });
			notify(ctx, `Jev API backend set to ${apiConfig(settings).label}. ${formatApiStatus()}`);
		} catch (error) {
			notify(ctx, `Could not save router settings: ${errorMessage(error)}`, "error");
		}
	}

	async function editModel(ctx: ExtensionContext, tier: ModelTier): Promise<void> {
		const models = availableTextModels(ctx);
		if (models.length === 0) {
			notify(ctx, "No authenticated text models are available in this Pi session.", "warning");
			return;
		}
		const labels = modelMenuLabels(models);
		const selected = await ctx.ui.select(`Choose ${tier} model`, [...labels.keys()]);
		const model = selected ? labels.get(selected) : undefined;
		if (!model) return;
		const reference = modelRef(model);
		try {
			persistSettings(tier === "cheap" ? { cheapModel: reference } : { expensiveModel: reference });
			notify(ctx, `${tier} model saved as ${reference}.`);
		} catch (error) {
			notify(ctx, `Could not save router settings: ${errorMessage(error)}`, "error");
		}
	}

	async function editConfidence(ctx: ExtensionContext): Promise<void> {
		const current = confidenceThreshold(settings);
		const raw = await ctx.ui.input(`Minimum confidence to use the cheap model (0–1; current ${current})`);
		if (raw === undefined) return;
		const value = Number(raw.trim());
		if (!raw.trim() || !Number.isFinite(value) || value < 0 || value > 1) {
			notify(ctx, "Confidence must be a number from 0 to 1.", "error");
			return;
		}
		try {
			persistSettings({ cheapConfidence: value });
			notify(ctx, `Cheap-tier confidence threshold saved as ${value}.`);
		} catch (error) {
			notify(ctx, `Could not save router settings: ${errorMessage(error)}`, "error");
		}
	}

	async function editCustomModel(ctx: ExtensionContext): Promise<void> {
		const current = settings.customModel || "jev-latest";
		const raw = await ctx.ui.input(`Custom model id sent to the endpoint (current ${current})`);
		if (raw === undefined) return;
		const value = raw.trim();
		if (!value || value.length > 128 || /[\u0000-\u001f\u007f]/.test(value)) {
			notify(ctx, "Model id must be 1–128 printable characters.", "error");
			return;
		}
		try {
			persistSettings({ customModel: value });
			notify(ctx, `Custom endpoint model id saved as ${value}.`);
		} catch (error) {
			notify(ctx, `Could not save router settings: ${errorMessage(error)}`, "error");
		}
	}

	async function chooseZenModel(ctx: ExtensionContext): Promise<void> {
		const free = "jev-1.13-free (limited-time availability)";
		const standard = "jev-1.13";
		const selected = await ctx.ui.select("Choose OpenCode Zen Jev model", [free, standard]);
		if (!selected) return;
		const model: ZenJevModel = selected === free ? "jev-1.13-free" : "jev-1.13";
		try {
			persistSettings({ zenModel: model });
			notify(ctx, `OpenCode Zen model set to ${model}. Availability and billing are controlled by OpenCode Zen.`);
		} catch (error) {
			notify(ctx, `Could not save router settings: ${errorMessage(error)}`, "error");
		}
	}

	async function editSessionApiKey(ctx: ExtensionContext): Promise<void> {
		const api = apiConfig(settings);
		const key = await promptMaskedApiKey(ctx, api.label);
		if (!key) return;
		sessionApiKeys[api.backend] = key;
		notify(ctx, `API key set for ${api.label} in this Pi process only; it is masked and not written to disk.`);
	}

	async function openSettingsMenu(ctx: ExtensionContext): Promise<void> {
		if (!ctx.hasUI) {
			notify(ctx, "The settings menu needs an interactive Pi UI; use /jev-router on|off|status here.", "warning");
			return;
		}
		const actions = [
			"Toggle auto-routing",
			"Choose API backend",
			"Set custom endpoint",
			"Set custom endpoint model id",
			"Choose OpenCode Zen Jev model",
			"Choose cheap model",
			"Choose expensive model",
			"Set cheap confidence threshold",
			"Set/replace masked session API key",
			"Clear session API key",
			"Show status",
			"Close",
		];
		while (true) {
			const refs = configuredModelRefs(settings);
			const api = apiConfig(settings);
			const selected = await ctx.ui.select(
				`Jev router · ${enabled ? "ON" : "OFF"}\nAPI: ${api.label} · ${api.model}\nModels: ${refs.cheap} → ${refs.expensive}\nCheap threshold: ${confidenceThreshold(settings)}`,
				actions,
			);
			if (!selected || selected === "Close") return;
			if (selected === "Toggle auto-routing") {
				if (enabled) await disableRouter(ctx);
				else {
					try {
						await enableRouter(ctx);
					} catch (error) {
						notify(ctx, errorMessage(error), "error");
					}
				}
			} else if (selected === "Choose API backend") {
				await chooseApiBackend(ctx);
			} else if (selected === "Set custom endpoint") {
				await editCustomEndpoint(ctx);
			} else if (selected === "Set custom endpoint model id") {
				await editCustomModel(ctx);
			} else if (selected === "Choose OpenCode Zen Jev model") {
				await chooseZenModel(ctx);
			} else if (selected === "Choose cheap model") {
				await editModel(ctx, "cheap");
			} else if (selected === "Choose expensive model") {
				await editModel(ctx, "expensive");
			} else if (selected === "Set cheap confidence threshold") {
				await editConfidence(ctx);
			} else if (selected === "Set/replace masked session API key") {
				await editSessionApiKey(ctx);
			} else if (selected === "Clear session API key") {
				delete sessionApiKeys[api.backend];
				notify(ctx, `Session-only key cleared for ${api.label}.`);
			} else if (selected === "Show status") {
				notify(ctx, `${formatApiStatus()}; router ${enabled ? "on" : "off"}; cheap=${refs.cheap}; expensive=${refs.expensive}; threshold=${confidenceThreshold(settings)}.`);
			}
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		// Routing is session-scoped; a new/resumed session starts opt-in again unless AUTO is set.
		enabled = false;
		switchedByRouter = false;
		baseModel = ctx.model;
		lastStatus = "ready";
		if (!autoStart) {
			updateStatus(ctx);
			return;
		}
		try {
			await enableRouter(ctx);
		} catch (error) {
			enabled = false;
			updateStatus(ctx);
			notify(ctx, `Jev auto-start was requested but could not be enabled: ${errorMessage(error)}`, "warning");
		}
	});

	pi.on("model_select", (event, ctx) => {
		if (!changingModelInternally && enabled) {
			baseModel = event.model;
			switchedByRouter = false;
			lastStatus = "ready · model updated";
		}
		updateStatus(ctx);
	});

	pi.on("before_agent_start", async (event: BeforeAgentStartEvent, ctx) => {
		if (!enabled) return;
		let api: JevApiConfig;
		try {
			api = apiConfig(settings);
		} catch (error) {
			enabled = false;
			updateStatus(ctx);
			notify(ctx, `Invalid Jev API configuration; router turned off: ${errorMessage(error)}`, "warning");
			return;
		}
		const credential = getApiKey(api.backend, api, sessionApiKeys);
		if (api.keyRequired && !credential.value) {
			enabled = false;
			updateStatus(ctx);
			notify(ctx, `Missing ${api.envKeyName}; Jev auto-routing has been turned off.`, "warning");
			return;
		}
		if (event.images?.length) {
			lastStatus = "skipped · image prompt";
			updateStatus(ctx);
			return;
		}

		const prompt = event.prompt.trim();
		let tier: ModelTier = "expensive";
		let fallbackReason: string | undefined;
		if (!prompt) fallbackReason = "empty task text";
		else if (prompt.length > MAX_PROMPT_CHARS) fallbackReason = `task exceeds ${MAX_PROMPT_CHARS} characters`;
		else {
			const controller = new AbortController();
			const abortFromPi = () => controller.abort();
			if (ctx.signal?.aborted) return;
			ctx.signal?.addEventListener("abort", abortFromPi, { once: true });
			const timeout = setTimeout(() => controller.abort(), JEV_TIMEOUT_MS);
			lastStatus = "classifying…";
			updateStatus(ctx);
			try {
				tier = await classifyTask(
					prompt,
					credential.value ?? "",
					confidenceThreshold(settings),
					controller.signal,
					undefined,
					{ backend: api.backend, endpoint: api.endpoint, model: api.model },
				);
			} catch (error) {
				if (ctx.signal?.aborted) return;
				fallbackReason = errorMessage(error);
			} finally {
				clearTimeout(timeout);
				ctx.signal?.removeEventListener("abort", abortFromPi);
			}
		}

		try {
			const models = resolveTierModels(ctx, settings);
			const target = models[tier];
			if (!sameModel(ctx.model, target)) await setModelInternally(target);
			switchedByRouter = !sameModel(target, baseModel);
			lastStatus = fallbackReason ? `fallback → ${tier}` : `→ ${tier}`;
			updateStatus(ctx);
			if (fallbackReason) notify(ctx, `Jev could not classify this prompt (${fallbackReason}); using the ${tier} model.`, "warning");
		} catch (error) {
			lastStatus = "model switch failed";
			updateStatus(ctx);
			notify(ctx, `Jev selected ${tier}, but Pi could not switch models: ${errorMessage(error)}`, "warning");
		}
	});

	pi.on("agent_settled", async (_event, ctx) => {
		if (!enabled || !switchedByRouter || !baseModel || sameModel(ctx.model, baseModel)) return;
		try {
			await setModelInternally(baseModel);
			switchedByRouter = false;
		} catch (error) {
			notify(ctx, `Could not restore ${modelRef(baseModel)} after the routed task: ${errorMessage(error)}`, "warning");
		}
	});

	pi.registerCommand("jev-router", {
		description: "Open Jev model-routing and API settings",
		getArgumentCompletions: (prefix) => ["menu", "on", "off", "status"].filter((item) => item.startsWith(prefix)).map((value) => ({ value, label: value })),
		handler: async (args, ctx) => {
			const action = args.trim().toLowerCase();
			if (!action || action === "menu") {
				await openSettingsMenu(ctx);
				return;
			}
			if (action === "on") {
				try {
					await enableRouter(ctx);
				} catch (error) {
					notify(ctx, errorMessage(error), "error");
				}
				return;
			}
			if (action === "off") {
				await disableRouter(ctx);
				return;
			}
			if (action === "status") {
				const refs = configuredModelRefs(settings);
				notify(ctx, `${formatApiStatus()}; router ${enabled ? "on" : "off"}; cheap=${refs.cheap}; expensive=${refs.expensive}; threshold=${confidenceThreshold(settings)}.`);
				return;
			}
			notify(ctx, "Usage: /jev-router [menu|on|off|status]", "warning");
		},
	});
}
