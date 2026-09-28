import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type JevBackend = "typesafe" | "opencode-zen" | "custom";
export type ZenJevModel = "jev-1.13" | "jev-1.13-free";

export interface RouterSettings {
	apiBackend?: JevBackend;
	customEndpoint?: string;
	customModel?: string;
	zenModel?: ZenJevModel;
	cheapModel?: string;
	expensiveModel?: string;
	cheapProbability?: number;
	autoStart?: boolean;
}

export function settingsFilePath(): string {
	const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
	return join(agentDir, "jev-router.json");
}

export function validateCustomEndpoint(value: string): string {
	let url: URL;
	try {
		url = new URL(value.trim());
	} catch {
		throw new Error("Enter a valid custom endpoint URL ending in /systemone");
	}
	if (url.username || url.password) throw new Error("Endpoint URLs must not contain credentials");
	if (url.search) throw new Error("Endpoint URLs must not contain a query string");
	if (url.hash) throw new Error("Endpoint URLs must not contain a fragment");
	if (!/\/systemone\/?$/i.test(url.pathname)) throw new Error("Custom endpoint path must end in /systemone");

	const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
	const localHost = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
	if (url.protocol !== "https:" && !(url.protocol === "http:" && localHost)) {
		throw new Error("Custom endpoints must use HTTPS (HTTP is allowed only for localhost)");
	}
	url.pathname = url.pathname.replace(/\/+$/, "");
	return url.toString().replace(/\/+$/, "");
}

function validText(value: unknown, maxLength = 256): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	if (!trimmed || trimmed.length > maxLength || /[\u0000-\u001f\u007f]/.test(trimmed)) return undefined;
	return trimmed;
}

function defaultRouterSettings(): RouterSettings {
	return { apiBackend: "opencode-zen", zenModel: "jev-1.13-free", autoStart: false };
}

export function normalizeRouterSettings(value: unknown): RouterSettings {
	if (!value || typeof value !== "object" || Array.isArray(value)) return defaultRouterSettings();
	const input = value as Record<string, unknown>;
	const apiBackend: JevBackend = input.apiBackend === "typesafe" || input.apiBackend === "custom" ? input.apiBackend : "opencode-zen";
	const result: RouterSettings = { apiBackend, autoStart: input.autoStart === true };
	if (apiBackend === "opencode-zen") result.zenModel = "jev-1.13-free";

	if (typeof input.customEndpoint === "string") {
		try {
			result.customEndpoint = validateCustomEndpoint(input.customEndpoint);
		} catch {
			// Ignore invalid saved URLs and require the user to enter a valid endpoint again.
		}
	}
	const customModel = validText(input.customModel, 128);
	if (customModel) result.customModel = customModel;
	if (input.zenModel === "jev-1.13" || input.zenModel === "jev-1.13-free") result.zenModel = input.zenModel;

	const cheapModel = validText(input.cheapModel, 256);
	if (cheapModel) result.cheapModel = cheapModel;
	const expensiveModel = validText(input.expensiveModel, 256);
	if (expensiveModel) result.expensiveModel = expensiveModel;
	const probability = typeof input.cheapProbability === "number" ? input.cheapProbability : input.cheapConfidence;
	if (typeof probability === "number" && Number.isFinite(probability) && probability >= 0 && probability <= 1) {
		result.cheapProbability = probability;
	}
	return result;
}

export function loadRouterSettings(path = settingsFilePath()): RouterSettings {
	try {
		return normalizeRouterSettings(JSON.parse(readFileSync(path, "utf8")));
	} catch {
		return defaultRouterSettings();
	}
}

export function saveRouterSettings(value: unknown, path = settingsFilePath()): RouterSettings {
	const settings = normalizeRouterSettings(value);
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const temporaryPath = `${path}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
	try {
		writeFileSync(temporaryPath, `${JSON.stringify(settings, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
		chmodSync(temporaryPath, 0o600);
		renameSync(temporaryPath, path);
		chmodSync(path, 0o600);
		return settings;
	} catch (error) {
		try {
			rmSync(temporaryPath, { force: true });
		} catch {
			// Preserve the original write error.
		}
		throw error;
	}
}
