import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadRouterSecrets, removeRouterSecret, saveRouterSecret } from "../router-secrets.ts";

test("persists backend API keys in a separate owner-only secrets file", () => {
	const dir = mkdtempSync(join(tmpdir(), "jev-router-secrets-test-"));
	const path = join(dir, "jev-router-secrets.json");
	try {
		saveRouterSecret("opencode-zen", "zen-test-key", path);
		saveRouterSecret("typesafe", "typesafe-test-key", path);
		assert.deepEqual(loadRouterSecrets(path), {
			"opencode-zen": "zen-test-key",
			typesafe: "typesafe-test-key",
		});
		assert.equal(statSync(path).mode & 0o777, 0o600);
		assert.equal(readFileSync(path, "utf8").includes("zen-test-key"), true);
		removeRouterSecret("opencode-zen", path);
		assert.deepEqual(loadRouterSecrets(path), { typesafe: "typesafe-test-key" });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
