export type ModelTier = "cheap" | "expensive";
export type JevBackend = "typesafe" | "opencode-zen" | "custom";

export interface JevApiOptions {
	backend: JevBackend;
	endpoint?: string;
	model?: string;
}

export interface TierClassification {
	tier: ModelTier;
	cheapProbability?: number;
}

const QUESTION_ID = "task_tier";
export const DEFAULT_CHEAP_PROBABILITY = 0.7;

function validProbability(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

/** Read Jev's direct yes-probability; also accept Choice responses from older compatible endpoints. */
export function classifyTier(response: unknown, threshold: number): TierClassification {
	const minimumProbability = validProbability(threshold) ? threshold : DEFAULT_CHEAP_PROBABILITY;
	if (!response || typeof response !== "object") return { tier: "expensive" };

	const answers = (response as { answers?: Record<string, unknown> }).answers;
	const answer = answers?.[QUESTION_ID];
	if (!answer || typeof answer !== "object") return { tier: "expensive" };

	const result = answer as {
		type?: unknown;
		noul?: unknown;
		choice?: unknown;
		probabilities?: Record<string, unknown>;
	};
	let cheapProbability: number | undefined;
	if (result.type === "noul") {
		if (validProbability(result.noul)) cheapProbability = result.noul;
	} else if (result.type === "choice" && (result.choice === "cheap" || result.choice === "expensive")) {
		const probabilities = result.probabilities;
		const cheap = probabilities?.cheap;
		const expensive = probabilities?.expensive;
		if (validProbability(cheap) && validProbability(expensive) && Math.abs(cheap + expensive - 1) <= 0.02) {
			const agreesWithDistribution = result.choice === "cheap" ? cheap >= expensive : expensive >= cheap;
			if (agreesWithDistribution) cheapProbability = cheap;
		}
	}

	if (cheapProbability === undefined) return { tier: "expensive" };
	return {
		tier: cheapProbability >= minimumProbability ? "cheap" : "expensive",
		cheapProbability,
	};
}

export function selectTier(response: unknown, threshold: number): ModelTier {
	return classifyTier(response, threshold).tier;
}

/** Ask Jev to classify only the supplied task text; callers own timeout and privacy controls. */
export async function classifyTask(
	state: string,
	apiKey: string,
	cheapProbabilityThreshold: number,
	signal?: AbortSignal,
	fetchImpl: typeof fetch = fetch,
	api: JevApiOptions = { backend: "typesafe" },
): Promise<TierClassification> {
	const endpoint = api.backend === "typesafe"
		? "https://api.typesafe.ai/v1/systemone"
		: api.backend === "opencode-zen"
			? "https://opencode.ai/zen/v1/systemone"
			: api.endpoint;
	const model = api.backend === "typesafe"
		? "jev-latest"
		: api.backend === "opencode-zen"
			? api.model || "jev-1.13-free"
			: api.model || "jev-latest";
	if (!endpoint) throw new Error("A custom Jev endpoint is required");

	const response = await fetchImpl(endpoint, {
		method: "POST",
		headers: {
			...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
			"Content-Type": "application/json",
		},
		signal,
		redirect: "error",
		body: JSON.stringify({
			state,
			model,
			questions: {
				[QUESTION_ID]: {
					type: "noul",
					instructions: "Would a lower-cost general chat model likely complete this task correctly without deeper reasoning? Judge the actual work requested, not how important the user says it is.",
					criteria: {
						true: "Routine, narrow, low-stakes work: a simple explanation, brief summary, straightforward formatting, one-step question, or small localized code edit.",
						false: "Multi-step coding or debugging, broad analysis or design, ambiguity, novel synthesis, high-stakes decisions, or work where missing nuance is likely to cause an error.",
					},
				},
			},
		}),
	});

	if (!response.ok) throw new Error(`Jev API returned HTTP ${response.status}`);
	let payload: unknown;
	try {
		payload = await response.json();
	} catch {
		throw new Error("Jev API returned invalid JSON");
	}
	return classifyTier(payload, cheapProbabilityThreshold);
}
