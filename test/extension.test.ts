import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import jevRouterExtension from "../index.ts";

test("router is opt-in, routes tasks, skips images, restores the base model, and can be disabled", async () => {
	const savedEnv = {
		key: process.env.OPENCODE_API_KEY,
		agentDir: process.env.PI_CODING_AGENT_DIR,
		auto: process.env.JEV_ROUTER_AUTO,
		cheap: process.env.JEV_ROUTER_CHEAP_MODEL,
		expensive: process.env.JEV_ROUTER_EXPENSIVE_MODEL,
	};
	const originalFetch = globalThis.fetch;
	const agentDir = mkdtempSync(join(tmpdir(), "jev-router-extension-test-"));
	process.env.PI_CODING_AGENT_DIR = agentDir;
	process.env.OPENCODE_API_KEY = "test-secret";
	delete process.env.TYPESAFE_API_KEY;
	delete process.env.JEV_ROUTER_AUTO;
	process.env.JEV_ROUTER_CHEAP_MODEL = "test/cheap";
	process.env.JEV_ROUTER_EXPENSIVE_MODEL = "test/expensive";

	try {
		const models = [
			{ provider: "test", id: "cheap", input: ["text"] },
			{ provider: "test", id: "expensive", input: ["text"] },
			{ provider: "test", id: "base", input: ["text"] },
		];
		let activeModel = models[2];
		const handlers = new Map<string, Array<(event: any, ctx: any) => any>>();
		const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
		const notices: string[] = [];
		let status: string | undefined;
		const ctx: any = {
			hasUI: true,
			mode: "tui",
			ui: {
				notify: (message: string) => notices.push(message),
				setStatus: (_key: string, value: string | undefined) => { status = value; },
			},
			modelRegistry: {
				find: (provider: string, id: string) => models.find((model) => model.provider === provider && model.id === id),
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
		await Promise.all((handlers.get("session_start") ?? []).map((handler) => handler({ type: "session_start", reason: "startup" }, ctx)));
		const beforeAgentStart = async (prompt: string, images?: unknown[]) => {
			for (const handler of handlers.get("before_agent_start") ?? []) {
				await handler({ type: "before_agent_start", prompt, images }, ctx);
			}
		};
		const agentSettled = async () => {
			for (const handler of handlers.get("agent_settled") ?? []) await handler({ type: "agent_settled" }, ctx);
		};
		const routerCommand = commands.get("jev-router");
		assert.ok(routerCommand);

		let requests = 0;
		let nextTier = "cheap";
		let failNextRequest = false;
		const submittedStates: string[] = [];
		globalThis.fetch = async (_input, init) => {
			requests++;
			if (failNextRequest) {
				failNextRequest = false;
				return new Response("unavailable", { status: 503 });
			}
			const body = JSON.parse(String(init?.body));
			submittedStates.push(body.state);
			const isCheap = nextTier === "cheap";
			return new Response(JSON.stringify({
				answers: { task_tier: { type: "choice", choice: nextTier, confidence: 0.95, probabilities: { cheap: isCheap ? 0.98 : 0.02, expensive: isCheap ? 0.02 : 0.98 } } },
			}), { status: 200, headers: { "Content-Type": "application/json" } });
		};
		await beforeAgentStart("Summarize this sentence");
		assert.equal(requests, 0, "router should be off until explicitly enabled");
		assert.equal(activeModel.id, "base");

		delete process.env.OPENCODE_API_KEY;
		await routerCommand.handler("on", ctx);
		assert.equal(status, undefined, "missing API key should leave the router off");
		assert.ok(notices.some((message) => message.includes("OPENCODE_API_KEY")));
		process.env.OPENCODE_API_KEY = "test-secret";
		await routerCommand.handler("on", ctx);

		await beforeAgentStart("Summarize this sentence");
		assert.equal(activeModel.id, "cheap");
		assert.match(status ?? "", /cheap/);
		assert.equal(submittedStates[0], "Summarize this sentence");
		await agentSettled();
		assert.equal(activeModel.id, "base", "restore model after task completion");

		nextTier = "expensive";
		await beforeAgentStart("Design a multi-step migration");
		assert.equal(activeModel.id, "expensive");
		await agentSettled();
		assert.equal(activeModel.id, "base", "restore model after expensive task");

		failNextRequest = true;
		await beforeAgentStart("Jev outage fallback");
		assert.equal(activeModel.id, "expensive", "API failure should fail toward the expensive model");
		assert.match(status ?? "", /fallback/);
		await agentSettled();
		assert.equal(activeModel.id, "base");

		const beforeImageRequests = requests;
		await beforeAgentStart("What is in this picture?", [{}]);
		assert.equal(requests, beforeImageRequests, "image prompts should not be sent to Jev");
		assert.equal(activeModel.id, "base", "image request must retain the user's model");

		await routerCommand.handler("off", ctx);
		const beforeDisabledRequests = requests;
		await beforeAgentStart("Summarize this sentence");
		assert.equal(requests, beforeDisabledRequests, "off must stop all Jev requests");
		assert.equal(activeModel.id, "base");
	} finally {
		globalThis.fetch = originalFetch;
		for (const [name, value] of Object.entries({
			OPENCODE_API_KEY: savedEnv.key,
			PI_CODING_AGENT_DIR: savedEnv.agentDir,
			JEV_ROUTER_AUTO: savedEnv.auto,
			JEV_ROUTER_CHEAP_MODEL: savedEnv.cheap,
			JEV_ROUTER_EXPENSIVE_MODEL: savedEnv.expensive,
		})) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
		rmSync(agentDir, { recursive: true, force: true });
	}
});
