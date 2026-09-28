import assert from "node:assert/strict";
import test from "node:test";
import { classifyTask, selectTier } from "../policy.ts";

test("selects cheap only for a confident cheap classification", () => {
	assert.equal(selectTier({ answers: { task_tier: { type: "choice", choice: "cheap", confidence: 0.9, probabilities: { cheap: 0.95, expensive: 0.05 } } } }, 0.8), "cheap");
	assert.equal(selectTier({ answers: { task_tier: { type: "choice", choice: "cheap", confidence: 0.79, probabilities: { cheap: 0.9, expensive: 0.1 } } } }, 0.8), "expensive");
});

test("routes expensive and malformed or uncertain answers conservatively", () => {
	assert.equal(selectTier({ answers: { task_tier: { type: "choice", choice: "expensive", confidence: 0.6, probabilities: { cheap: 0.4, expensive: 0.6 } } } }, 0.8), "expensive");
	assert.equal(selectTier({ answers: { task_tier: { type: "noul", noul: 0 } } }, 0.8), "expensive");
	assert.equal(selectTier({ answers: { task_tier: { type: "choice", choice: "unknown", confidence: 1, probabilities: { cheap: 0, expensive: 1 } } } }, 0.8), "expensive");
	assert.equal(selectTier({ answers: { task_tier: { type: "choice", choice: "cheap", confidence: 1, probabilities: { cheap: 0, expensive: 1 } } } }, 0.8), "expensive");
	assert.equal(selectTier({}, 0.8), "expensive");
});

test("posts the current task to the official TypeSafe endpoint with bearer auth", async () => {
	let capturedUrl = "";
	let capturedInit: RequestInit | undefined;
	const fakeFetch: typeof fetch = async (input, init) => {
		capturedUrl = String(input);
		capturedInit = init;
		return new Response(JSON.stringify({
			answers: { task_tier: { type: "choice", choice: "cheap", confidence: 0.95, probabilities: { cheap: 0.98, expensive: 0.02 } } },
		}), { status: 200, headers: { "Content-Type": "application/json" } });
	};

	const tier = await classifyTask("Summarize this sentence", "test-secret", 0.8, undefined, fakeFetch);
	assert.equal(tier, "cheap");
	assert.equal(capturedUrl, "https://api.typesafe.ai/v1/systemone");
	assert.equal(capturedInit?.method, "POST");
	assert.equal(new Headers(capturedInit?.headers).get("Authorization"), "Bearer test-secret");
	const body = JSON.parse(String(capturedInit?.body));
	assert.equal(body.state, "Summarize this sentence");
	assert.equal(body.model, "jev-latest");
	assert.equal(body.questions.task_tier.type, "choice");
});

test("uses OpenCode Zen's Jev endpoint and selected model", async () => {
	let capturedUrl = "";
	let capturedInit: RequestInit | undefined;
	const fakeFetch: typeof fetch = async (input, init) => {
		capturedUrl = String(input);
		capturedInit = init;
		return new Response(JSON.stringify({ answers: {} }), { status: 200 });
	};
	await classifyTask("task", "zen-key", 0.8, undefined, fakeFetch, { backend: "opencode-zen", model: "jev-1.13-free" });
	assert.equal(capturedUrl, "https://opencode.ai/zen/v1/systemone");
	assert.equal(JSON.parse(String(capturedInit?.body)).model, "jev-1.13-free");
	assert.equal(new Headers(capturedInit?.headers).get("Authorization"), "Bearer zen-key");
	assert.equal(capturedInit?.redirect, "error");
});

test("supports a custom Jev-compatible endpoint and omits auth when no key is configured", async () => {
	let capturedUrl = "";
	let capturedInit: RequestInit | undefined;
	const fakeFetch: typeof fetch = async (input, init) => {
		capturedUrl = String(input);
		capturedInit = init;
		return new Response(JSON.stringify({ answers: {} }), { status: 200 });
	};
	await classifyTask("task", "", 0.8, undefined, fakeFetch, {
		backend: "custom",
		endpoint: "https://proxy.example/v1/systemone",
		model: "jev-custom-v2",
	});
	assert.equal(capturedUrl, "https://proxy.example/v1/systemone");
	assert.equal(JSON.parse(String(capturedInit?.body)).model, "jev-custom-v2");
	assert.equal(new Headers(capturedInit?.headers).has("Authorization"), false);
});

test("treats TypeSafe HTTP errors as classification failures", async () => {
	const fakeFetch: typeof fetch = async () => new Response("unavailable", { status: 503 });
	await assert.rejects(() => classifyTask("task", "test-secret", 0.8, undefined, fakeFetch), /HTTP 503/);
});
