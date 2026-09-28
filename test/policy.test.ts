import assert from "node:assert/strict";
import test from "node:test";
import { classifyTask, classifyTier, selectTier } from "../policy.ts";

const noulResponse = (probability: number) => ({
	answers: { task_tier: { type: "noul", noul: probability } },
});

test("routes on the direct Noul probability at the configured threshold", () => {
	assert.equal(selectTier(noulResponse(0.9), 0.7), "cheap");
	assert.equal(selectTier(noulResponse(0.7), 0.7), "cheap");
	assert.equal(selectTier(noulResponse(0.69), 0.7), "expensive");
	assert.equal(selectTier(noulResponse(0), 0.7), "expensive");
});

test("routes malformed answers and invalid probabilities conservatively", () => {
	assert.equal(selectTier({}, 0.7), "expensive");
	assert.equal(selectTier({ answers: { task_tier: { type: "noul", noul: 2 } } }, 0.7), "expensive");
	assert.equal(selectTier({ answers: { task_tier: { type: "noul", noul: "0.9" } } }, 0.7), "expensive");
});

test("retains Choice compatibility without applying derived confidence a second time", () => {
	const response = {
		answers: {
			task_tier: {
				type: "choice",
				choice: "cheap",
				confidence: 0.5,
				probabilities: { cheap: 0.85, expensive: 0.15 },
			},
		},
	};
	assert.equal(selectTier(response, 0.8), "cheap");
	assert.deepEqual(classifyTier(response, 0.8), { tier: "cheap", cheapProbability: 0.85 });
});

test("posts a Noul question to TypeSafe and uses the response probability", async () => {
	let capturedUrl = "";
	let capturedInit: RequestInit | undefined;
	const fakeFetch: typeof fetch = async (input, init) => {
		capturedUrl = String(input);
		capturedInit = init;
		return new Response(JSON.stringify(noulResponse(0.82)), { status: 200, headers: { "Content-Type": "application/json" } });
	};

	const decision = await classifyTask("Summarize this sentence", "test-secret", 0.7, undefined, fakeFetch);
	assert.deepEqual(decision, { tier: "cheap", cheapProbability: 0.82 });
	assert.equal(capturedUrl, "https://api.typesafe.ai/v1/systemone");
	assert.equal(capturedInit?.method, "POST");
	assert.equal(new Headers(capturedInit?.headers).get("Authorization"), "Bearer test-secret");
	const body = JSON.parse(String(capturedInit?.body));
	assert.equal(body.state, "Summarize this sentence");
	assert.equal(body.model, "jev-latest");
	assert.equal(body.questions.task_tier.type, "noul");
});

test("uses OpenCode Zen's Jev Free endpoint and model", async () => {
	let capturedUrl = "";
	let capturedInit: RequestInit | undefined;
	const fakeFetch: typeof fetch = async (input, init) => {
		capturedUrl = String(input);
		capturedInit = init;
		return new Response(JSON.stringify(noulResponse(0.2)), { status: 200 });
	};
	const decision = await classifyTask("task", "zen-key", 0.7, undefined, fakeFetch, { backend: "opencode-zen", model: "jev-1.13-free" });
	assert.deepEqual(decision, { tier: "expensive", cheapProbability: 0.2 });
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
		return new Response(JSON.stringify(noulResponse(0.95)), { status: 200 });
	};
	await classifyTask("task", "", 0.7, undefined, fakeFetch, {
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
	await assert.rejects(() => classifyTask("task", "test-secret", 0.7, undefined, fakeFetch), /HTTP 503/);
});
