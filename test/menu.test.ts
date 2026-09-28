import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import jevRouterExtension from "../index.ts";

test("settings menu masks session keys, saves endpoint/model settings, and routes through a custom endpoint", async () => {
	const agentDir = mkdtempSync(join(tmpdir(), "jev-router-menu-test-"));
	const savedEnv = {
		agentDir: process.env.PI_CODING_AGENT_DIR,
		apiKey: process.env.TYPESAFE_API_KEY,
		customKey: process.env.JEV_ROUTER_CUSTOM_API_KEY,
		zenKey: process.env.OPENCODE_API_KEY,
		cheapModel: process.env.JEV_ROUTER_CHEAP_MODEL,
		expensiveModel: process.env.JEV_ROUTER_EXPENSIVE_MODEL,
		backend: process.env.JEV_ROUTER_AUTO,
	};
	const originalFetch = globalThis.fetch;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	process.env.JEV_ROUTER_CHEAP_MODEL = "test/cheap";
	process.env.JEV_ROUTER_EXPENSIVE_MODEL = "test/expensive";
	delete process.env.TYPESAFE_API_KEY;
	delete process.env.JEV_ROUTER_CUSTOM_API_KEY;
	delete process.env.OPENCODE_API_KEY;
	delete process.env.JEV_ROUTER_AUTO;

	try {
		const models = [
			{ provider: "test", id: "cheap", name: "Cheap test", input: ["text"] },
			{ provider: "test", id: "expensive", name: "Expensive test", input: ["text"] },
			{ provider: "test", id: "base", name: "Base test", input: ["text"] },
		];
		let activeModel = models[2];
		const handlers = new Map<string, Array<(event: any, ctx: any) => any>>();
		const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
		const notices: string[] = [];
		const selections: string[] = [];
		const inputs: string[] = [];
		const keyRenderings: string[] = [];
		let confirmCount = 0;
		const ctx: any = {
			hasUI: true,
			mode: "tui",
			ui: {
				notify: (message: string) => notices.push(message),
				setStatus: () => {},
				select: async (_title: string, options: string[]) => {
					const selection = selections.shift();
					assert.ok(selection && options.includes(selection), `unexpected menu option: ${selection}`);
					return selection;
				},
				input: async () => inputs.shift(),
				confirm: async () => { confirmCount++; return true; },
				custom: async (factory: (tui: any, theme: any, keybindings: any, done: (result: unknown) => void) => any) => {
					let result: unknown;
					const component = factory(
						{ requestRender: () => {} },
						{},
						{ matches: (key: string, action: string) => action === "tui.input.submit" && key === "ENTER" },
						(value: unknown) => { result = value; },
					);
					for (const char of "session-secret") component.handleInput(char);
					const rendered = component.render(80).join("\n");
					keyRenderings.push(rendered);
					assert.equal(rendered.includes("session-secret"), false, "key must never be rendered in plaintext");
					assert.ok(rendered.includes("*"));
					component.handleInput("ENTER");
					component.dispose?.();
					return result;
				},
			},
			modelRegistry: {
				find: (provider: string, id: string) => models.find((model) => model.provider === provider && model.id === id),
				getAvailable: () => models,
				hasConfiguredAuth: () => true,
			},
			scopedModels: [],
			signal: undefined,
		};
		Object.defineProperty(ctx, "model", { get: () => activeModel });

		const pi: any = {
			on: (name: string, handler: (event: any, context: any) => any) => {
				const list = handlers.get(name) ?? [];
				list.push(handler);
				handlers.set(name, list);
			},
			registerCommand: (name: string, command: { handler: (args: string, context: any) => Promise<void> }) => commands.set(name, command),
			setModel: async (model: typeof activeModel) => {
				const previousModel = activeModel;
				activeModel = model;
				for (const handler of handlers.get("model_select") ?? []) {
					await handler({ type: "model_select", model, previousModel, source: "set" }, ctx);
				}
				return true;
			},
		};
		jevRouterExtension(pi);
		const router = commands.get("jev-router");
		assert.ok(router);

		selections.push("Choose API backend", "TypeSafe direct (jev-latest)", "Close");
		await router.handler("menu", ctx);
		selections.push("Set/replace and remember masked API key", "Close");
		await router.handler("menu", ctx);
		assert.equal(keyRenderings.length, 1);
		const initialSettings = readFileSync(join(agentDir, "jev-router.json"), "utf8");
		const savedKeysPath = join(agentDir, "jev-router-secrets.json");
		const savedKeys = readFileSync(savedKeysPath, "utf8");
		assert.equal(JSON.parse(initialSettings).apiBackend, "typesafe");
		assert.equal(initialSettings.includes("session-secret"), false, "key must not enter ordinary settings");
		assert.ok(savedKeys.includes("session-secret"), "menu key should be remembered privately");
		assert.equal(statSync(savedKeysPath).mode & 0o777, 0o600);

		const probeHandlers = new Map<string, Array<(event: any, ctx: any) => any>>();
		const probeCommands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
		const probePi: any = {
			on: (name: string, handler: (event: any, context: any) => any) => {
				const list = probeHandlers.get(name) ?? [];
				list.push(handler);
				probeHandlers.set(name, list);
			},
			registerCommand: (name: string, command: { handler: (args: string, context: any) => Promise<void> }) => probeCommands.set(name, command),
			setModel: async () => true,
		};
		jevRouterExtension(probePi);
		for (const handler of probeHandlers.get("session_start") ?? []) await handler({ type: "session_start", reason: "startup" }, ctx);
		const probeRouter = probeCommands.get("jev-router");
		assert.ok(probeRouter);
		await probeRouter.handler("status", ctx);
		assert.ok(notices.some((message) => message.includes("saved private key")), "a fresh extension runtime should load the saved key");
		await probeRouter.handler("on", ctx);
		assert.ok(notices.some((message) => message.includes("Jev auto-routing is on")), "saved API key should allow enabling after reload");
		await probeRouter.handler("off", ctx);

		inputs.push("https://proxy.example/v1/systemone");
		selections.push("Choose API backend", "Custom Jev-compatible endpoint", "Close");
		await router.handler("menu", ctx);
		assert.equal(confirmCount, 1, "custom endpoint should require explicit trust confirmation");

		selections.push("Choose cheap model", "test/cheap — Cheap test", "Close");
		await router.handler("menu", ctx);
		inputs.push("0.91");
		selections.push("Set cheap probability threshold", "Close");
		await router.handler("menu", ctx);

		selections.push("Choose API backend", "OpenCode Zen (Jev 1.13; separate from Go)", "Close");
		await router.handler("menu", ctx);
		assert.equal(confirmCount, 2, "OpenCode Zen must display its separate-billing confirmation");
		selections.push("Choose OpenCode Zen Jev model", "jev-1.13-free (limited-time availability)", "Close");
		await router.handler("menu", ctx);
		await router.handler("on", ctx);
		assert.ok(notices.some((message) => message.includes("OPENCODE_API_KEY")), "Zen should require its own key");

		selections.push("Choose API backend", "Custom Jev-compatible endpoint", "Close");
		await router.handler("menu", ctx);
		const settingsPath = join(agentDir, "jev-router.json");
		const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
		assert.equal(settings.apiBackend, "custom");
		assert.equal(settings.customEndpoint, "https://proxy.example/v1/systemone");
		assert.equal(settings.cheapModel, "test/cheap");
		assert.equal(settings.cheapProbability, 0.91);
		assert.equal(settings.autoStart, false, "router remains opt-in until /on is used");
		assert.equal(settings.zenModel, "jev-1.13-free");
		assert.equal(readFileSync(settingsPath, "utf8").includes("session-secret"), false);
		assert.equal(statSync(settingsPath).mode & 0o777, 0o600);

		await router.handler("on", ctx);
		assert.equal(JSON.parse(readFileSync(settingsPath, "utf8")).autoStart, true, "/on should remember auto-start");
		let capturedUrl = "";
		let capturedAuth: string | null = null;
		globalThis.fetch = async (input, init) => {
			capturedUrl = String(input);
			capturedAuth = new Headers(init?.headers).get("Authorization");
			return new Response(JSON.stringify({
				answers: { task_tier: { type: "noul", noul: 0.98 } },
			}), { status: 200, headers: { "Content-Type": "application/json" } });
		};
		for (const handler of handlers.get("before_agent_start") ?? []) {
			await handler({ type: "before_agent_start", prompt: "Small request" }, ctx);
		}
		assert.equal(capturedUrl, "https://proxy.example/v1/systemone");
		assert.equal(capturedAuth, null, "saved TypeSafe key must not be sent to a different backend");
		assert.equal(activeModel.id, "cheap");
		for (const handler of handlers.get("agent_settled") ?? []) await handler({ type: "agent_settled" }, ctx);
		assert.equal(activeModel.id, "base");
		await router.handler("off", ctx);
		assert.equal(notices.some((message) => message.includes("session-secret")), false);
	} finally {
		globalThis.fetch = originalFetch;
		for (const [name, value] of Object.entries({
			PI_CODING_AGENT_DIR: savedEnv.agentDir,
			TYPESAFE_API_KEY: savedEnv.apiKey,
			JEV_ROUTER_CUSTOM_API_KEY: savedEnv.customKey,
			OPENCODE_API_KEY: savedEnv.zenKey,
			JEV_ROUTER_CHEAP_MODEL: savedEnv.cheapModel,
			JEV_ROUTER_EXPENSIVE_MODEL: savedEnv.expensiveModel,
			JEV_ROUTER_AUTO: savedEnv.backend,
		})) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
		rmSync(agentDir, { recursive: true, force: true });
	}
});
