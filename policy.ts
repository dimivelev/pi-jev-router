export type ModelTier = "cheap" | "expensive";
export type JevBackend = "typesafe" | "opencode-zen" | "custom";

export interface JevApiOptions {
	backend: JevBackend;
	endpoint?: string;
	model?: string;
}

const CHOICE_ID = "task_tier";
const DEFAULT_CHEAP_CONFIDENCE = 0.8;

/** Fail toward the expensive tier unless Jev returns a valid, confident cheap decision. */
export function selectTier(response: unknown, threshold: number): ModelTier {
	const minimumConfidence = Number.isFinite(threshold) && threshold >= 0 && threshold <= 1
		? threshold
		: DEFAULT_CHEAP_CONFIDENCE;
	if (!response || typeof response !== "object") return "expensive";

	const answers = (response as { answers?: Record<string, unknown> }).answers;
	const answer = answers?.[CHOICE_ID];
	if (!answer || typeof answer !== "object") return "expensive";

	const result = answer as {
		type?: unknown;
		choice?: unknown;
		confidence?: unknown;
		probabilities?: Record<string, unknown>;
	};
	if (result.type !== "choice" || (result.choice !== "cheap" && result.choice !== "expensive")) return "expensive";
	if (typeof result.confidence !== "number" || !Number.isFinite(result.confidence) || result.confidence < 0 || result.confidence > 1) {
		return "expensive";
	}

	const probabilities = result.probabilities;
	const cheapProbability = probabilities?.cheap;
	const expensiveProbability = probabilities?.expensive;
	if (
		typeof cheapProbability !== "number" || !Number.isFinite(cheapProbability) || cheapProbability < 0 || cheapProbability > 1 ||
		typeof expensiveProbability !== "number" || !Number.isFinite(expensiveProbability) || expensiveProbability < 0 || expensiveProbability > 1 ||
		Math.abs(cheapProbability + expensiveProbability - 1) > 0.02
	) {
		return "expensive";
	}

	const selectedProbability = result.choice === "cheap" ? cheapProbability : expensiveProbability;
	const otherProbability = result.choice === "cheap" ? expensiveProbability : cheapProbability;
	if (selectedProbability < otherProbability) return "expensive";
	return result.choice === "cheap" && result.confidence >= minimumConfidence ? "cheap" : "expensive";
}

/** Ask Jev to classify only the supplied task text; callers own timeout and privacy controls. */
export async function classifyTask(
	state: string,
	apiKey: string,
	confidenceThreshold: number,
	signal?: AbortSignal,
	fetchImpl: typeof fetch = fetch,
	api: JevApiOptions = { backend: "typesafe" },
): Promise<ModelTier> {
	const endpoint = api.backend === "typesafe"
		? "https://api.typesafe.ai/v1/systemone"
		: api.backend === "opencode-zen"
			? "https://opencode.ai/zen/v1/systemone"
			: api.endpoint;
	const model = api.backend === "typesafe" ? "jev-latest" : api.backend === "opencode-zen" ? (api.model || "jev-1.13") : (api.model || "jev-latest");
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
				[CHOICE_ID]: {
					type: "choice",
					instructions: "Choose the model tier that can complete this task reliably, using only the supplied task text. If uncertain, choose expensive.",
					criteria: {
						cheap: "A clear, narrow, low-stakes, routine one-step task: simple explanation, brief summary, straightforward formatting, or a tiny localized change.",
						expensive: "A multi-step, ambiguous, novel, or high-stakes task; substantial coding, debugging, design, planning, analysis, or anything where missing nuance could reduce correctness.",
					},
				},
			},
		}),
	});

	if (!response.ok) throw new Error(`TypeSafe API returned HTTP ${response.status}`);
	let payload: unknown;
	try {
		payload = await response.json();
	} catch {
		throw new Error("TypeSafe API returned invalid JSON");
	}
	return selectTier(payload, confidenceThreshold);
}
