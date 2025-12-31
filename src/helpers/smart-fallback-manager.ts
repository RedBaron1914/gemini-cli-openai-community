import { Env } from "../types";
import { KV_COOLDOWN_KEY_PRO, KV_COOLDOWN_KEY_FLASH } from "../config";

export type FallbackMode = "dynamic" | "personal";

export interface FallbackDecision {
	mode: FallbackMode;
	model: string;
	projectId: string | null;
}

const FALLBACK_MODEL_MAP: Record<string, string> = {
	"gemini-pro-auto": "gemini-2.5-pro",
	"gemini-flash-auto": "gemini-2.5-flash"
};

const DYNAMIC_MODEL_MAP: Record<string, string> = {
	"gemini-pro-auto": "gemini-3-pro-preview",
	"gemini-flash-auto": "gemini-3-flash-preview"
};

/**
 * Manages the smart fallback logic between dynamic and personal project IDs.
 */
export class SmartFallbackManager {
	private env: Env;

	constructor(env: Env) {
		this.env = env;
	}

	private getCooldownKey(model: string): string {
		if (model.includes("pro")) {
			return KV_COOLDOWN_KEY_PRO;
		}
		return KV_COOLDOWN_KEY_FLASH;
	}

	/**
	 * Checks if the dynamic projectId is currently in a cooldown period for a specific model type.
	 * @returns The timestamp (in milliseconds) until which the cooldown is active, or 0 if not active.
	 */
	public async getCooldownUntil(model: string): Promise<number> {
		try {
			const key = this.getCooldownKey(model);
			const cooldownUntilStr = await this.env.GEMINI_CLI_KV.get(key);
			if (cooldownUntilStr) {
				const cooldownUntil = parseInt(cooldownUntilStr, 10);
				if (cooldownUntil > Date.now()) {
					return cooldownUntil;
				}
			}
		} catch (e) {
			console.error("Failed to get cooldown status from KV:", e);
		}
		return 0;
	}

	/**
	 * Sets the cooldown period for the dynamic projectId for a specific model type.
	 * @param quotaResetTimestamp The ISO 8601 timestamp string when the quota resets.
	 * @param model The auto model that hit the quota limit.
	 */
	public async setCooldown(quotaResetTimestamp: string, model: string): Promise<void> {
		try {
			const resetTime = new Date(quotaResetTimestamp).getTime();
			// Add a 1-minute buffer to be safe
			const cooldownUntil = resetTime + 60 * 1000;
			const ttl = Math.ceil((cooldownUntil - Date.now()) / 1000);
			const key = this.getCooldownKey(model);

			if (ttl > 0) {
				await this.env.GEMINI_CLI_KV.put(key, cooldownUntil.toString(), {
					expirationTtl: ttl
				});
				console.log(`Smart Fallback: Cooldown for ${model} set until ${new Date(cooldownUntil).toISOString()}`);
			}
		} catch (e) {
			console.error("Failed to set cooldown in KV:", e);
		}
	}

	/**
	 * Decides which mode, model, and projectId to use based on the cooldown status.
	 * @param requestedModel The original "auto" model requested by the user.
	 * @returns An object with the determined mode, model, and projectId.
	 */
	public async decide(requestedModel: string): Promise<FallbackDecision> {
		const cooldownUntil = await this.getCooldownUntil(requestedModel);
		const personalProjectId = this.env.GEMINI_PROJECT_ID || null;

		if (cooldownUntil > 0 && personalProjectId) {
			// Cooldown is active and a personal project ID is available, so we must fall back.
			const fallbackModel = FALLBACK_MODEL_MAP[requestedModel];
			if (fallbackModel) {
				console.log(`Smart Fallback: Cooldown active for ${requestedModel}. Using personal project and model '${fallbackModel}'.`);
				return {
					mode: "personal",
					model: fallbackModel,
					projectId: personalProjectId
				};
			}
		}

		// Default behavior: No cooldown, or no personal project ID to fall back to.
		// Try to use the dynamic project and the latest model.
		const dynamicModel = DYNAMIC_MODEL_MAP[requestedModel];
		if (dynamicModel) {
			console.log(`Smart Fallback: Attempting to use dynamic project and model '${dynamicModel}'.`);
			return {
				mode: "dynamic",
				model: dynamicModel,
				projectId: null // Let the client discover it
			};
		}

		// If the requested model is not an "auto" model, just use it directly.
		// This path shouldn't be hit if called correctly, but it's a safe default.
		console.log(`Smart Fallback: Passthrough for model '${requestedModel}'.`);
		return {
			mode: personalProjectId ? "personal" : "dynamic",
			model: requestedModel,
			projectId: personalProjectId
		};
	}

	/**
	 * Checks if a given model is one of the special "auto" models.
	 */
	public static isAutoModel(model: string): boolean {
		return model in FALLBACK_MODEL_MAP;
	}
}
