import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { JevBackend } from "./policy.ts";

export type RouterSecrets = Partial<Record<JevBackend, string>>;

export function secretsFilePath(): string {
	const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
	return join(agentDir, "jev-router-secrets.json");
}

function normalizeSecrets(value: unknown): RouterSecrets {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	const input = value as Record<string, unknown>;
	const result: RouterSecrets = {};
	for (const backend of ["typesafe", "opencode-zen", "custom"] as const) {
		const key = input[backend];
		if (typeof key === "string") {
			const trimmed = key.trim();
			if (trimmed && trimmed.length <= 4096 && !/[\u0000-\u001f\u007f]/.test(trimmed)) result[backend] = trimmed;
		}
	}
	return result;
}

export function loadRouterSecrets(path = secretsFilePath()): RouterSecrets {
	try {
		chmodSync(path, 0o600);
		return normalizeSecrets(JSON.parse(readFileSync(path, "utf8")));
	} catch {
		return {};
	}
}

function writeSecrets(secrets: RouterSecrets, path: string): RouterSecrets {
	const normalized = normalizeSecrets(secrets);
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const temporaryPath = `${path}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
	try {
		writeFileSync(temporaryPath, `${JSON.stringify(normalized, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
		chmodSync(temporaryPath, 0o600);
		renameSync(temporaryPath, path);
		chmodSync(path, 0o600);
		return normalized;
	} catch (error) {
		try {
			rmSync(temporaryPath, { force: true });
		} catch {
			// Preserve the original write error.
		}
		throw error;
	}
}

export function saveRouterSecret(backend: JevBackend, key: string, path = secretsFilePath()): RouterSecrets {
	const trimmed = key.trim();
	if (!trimmed || trimmed.length > 4096 || /[\u0000-\u001f\u007f]/.test(trimmed)) {
		throw new Error("API key must be 1–4096 printable characters");
	}
	return writeSecrets({ ...loadRouterSecrets(path), [backend]: trimmed }, path);
}

export function removeRouterSecret(backend: JevBackend, path = secretsFilePath()): RouterSecrets {
	const secrets = loadRouterSecrets(path);
	delete secrets[backend];
	if (Object.keys(secrets).length === 0) {
		rmSync(path, { force: true });
		return {};
	}
	return writeSecrets(secrets, path);
}
