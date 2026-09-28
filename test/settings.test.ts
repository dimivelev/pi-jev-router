import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadRouterSettings, normalizeRouterSettings, saveRouterSettings, validateCustomEndpoint } from "../router-settings.ts";

test("defaults to OpenCode Zen Jev Free and validates custom API endpoints", () => {
	assert.equal(normalizeRouterSettings({}).apiBackend, "opencode-zen");
	assert.equal(normalizeRouterSettings({}).zenModel, "jev-1.13-free");
	assert.equal(normalizeRouterSettings({}).autoStart, false);
	assert.equal(validateCustomEndpoint("https://example.com/v1/systemone"), "https://example.com/v1/systemone");
	assert.equal(validateCustomEndpoint("http://localhost:9911/v1/systemone"), "http://localhost:9911/v1/systemone");
	assert.throws(() => validateCustomEndpoint("http://example.com/v1/systemone"), /HTTPS/);
	assert.throws(() => validateCustomEndpoint("ftp://example.com/v1/systemone"), /HTTPS/);
	assert.throws(() => validateCustomEndpoint("https://user:pass@example.com/v1/systemone"), /credentials/);
	assert.throws(() => validateCustomEndpoint("https://example.com/v1/systemone?key=secret"), /query/);
	assert.throws(() => validateCustomEndpoint("https://example.com/v1/chat/completions"), /systemone/);
});

test("persists only validated non-secret settings with private permissions", () => {
	const dir = mkdtempSync(join(tmpdir(), "jev-router-test-"));
	const path = join(dir, "jev-router.json");
	try {
		saveRouterSettings({
			apiBackend: "custom",
			customEndpoint: "https://proxy.example/v1/systemone",
			customModel: "jev-1.13",
			cheapModel: "opencode-go/deepseek-v4-flash",
			expensiveModel: "openai-codex/gpt-6-astra",
			cheapProbability: 0.87,
			autoStart: true,
			apiKey: "must-not-persist",
		} as any, path);
		const saved = readFileSync(path, "utf8");
		assert.equal(JSON.parse(saved).apiBackend, "custom");
		assert.equal(JSON.parse(saved).cheapProbability, 0.87);
		assert.equal(JSON.parse(saved).autoStart, true);
		assert.equal(saved.includes("must-not-persist"), false);
		assert.equal(statSync(path).mode & 0o777, 0o600);
		assert.deepEqual(loadRouterSettings(path), {
			apiBackend: "custom",
			customEndpoint: "https://proxy.example/v1/systemone",
			customModel: "jev-1.13",
			cheapModel: "opencode-go/deepseek-v4-flash",
			expensiveModel: "openai-codex/gpt-6-astra",
			cheapProbability: 0.87,
			autoStart: true,
		});
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("drops invalid saved fields and invalid custom endpoints", () => {
	assert.deepEqual(normalizeRouterSettings({
		apiBackend: "other",
		customEndpoint: "http://not-local.example/v1/systemone",
		cheapConfidence: 8,
		cheapModel: "  ",
	}), { apiBackend: "opencode-zen", zenModel: "jev-1.13-free", autoStart: false });
});
