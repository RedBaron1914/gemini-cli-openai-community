import { Hono } from "hono";
import { Env, ChatCompletionRequest, ChatCompletionResponse, ChatMessage, ModelInfo, MessageContent } from "../types";
import { DEFAULT_MODEL, getAllModelIds } from "../models";
import { OPENAI_MODEL_OWNER } from "../config";
import { DEFAULT_THINKING_BUDGET, MIME_TYPE_MAP } from "../constants";
import { AuthManager } from "../auth";
import { GeminiApiClient } from "../gemini-client";
import { SmartFallbackManager } from "../helpers/smart-fallback-manager";
import { createOpenAIStreamTransformer } from "../stream-transformer";
import { isMediaTypeSupported, validateContent, validateModel } from "../utils/validation";
import { Buffer } from "node:buffer";

// Helper function to remove thinking blocks from message content
function stripThinkingBlocks(messages: ChatCompletionRequest["messages"]): ChatCompletionRequest["messages"] {
	if (!messages) return [];
	const thinkingRegex = /<thinking>[\s\S]*?<\/thinking>\s*/g;
	return messages.map((msg) => {
		if (typeof msg.content === "string") {
			return { ...msg, content: msg.content.replace(thinkingRegex, "") };
		}
		// Note: This doesn't handle array content, as thinking blocks are not expected there.
		return msg;
	});
}

/**
 * OpenAI-compatible API routes for models and chat completions.
 */
export const OpenAIRoute = new Hono<{ Bindings: Env }>();

// List available models
OpenAIRoute.get("/models", async (c) => {
	const modelData = getAllModelIds().map((modelId) => ({
		id: modelId,
		object: "model",
		created: Math.floor(Date.now() / 1000),
		owned_by: OPENAI_MODEL_OWNER
	}));

	return c.json({
		object: "list",
		data: modelData
	});
});

// Retrieve a specific model
OpenAIRoute.get("/models/:model", async (c) => {
	const modelId = c.req.param("model");
	const allRealModels = getAllModelIds();

	if (allRealModels.includes(modelId)) {
		const modelData = {
			id: modelId,
			object: "model",
			created: Math.floor(Date.now() / 1000),
			owned_by: OPENAI_MODEL_OWNER
		};
		return c.json(modelData);
	} else {
		return c.json({ error: "Model not found" }, 404);
	}
});

// Chat completions endpoint
OpenAIRoute.post("/chat/completions", async (c) => {
	try {
		console.log("Chat completions request received");
		const body = await c.req.json<ChatCompletionRequest>();
		// --- Chub.AI Compatibility: Handle 'template' field ---
		// If 'messages' is missing but a 'template' field is present, create a messages array from it.
		if (!body.messages && (body as any).template) {
			console.log("Handling non-standard 'template' field for compatibility.");
			body.messages = [{ role: "user", content: (body as any).template }];
		}
		// --- End Compatibility ---

		const model = body.model || DEFAULT_MODEL;
		const messages = body.messages || [];
		// OpenAI API compatibility: stream defaults to true unless explicitly set to false
		const stream = body.stream !== false;

		// Extract system prompt and user/assistant messages first to allow for prompt-based commands
		let systemPrompt = "";
		const otherMessages = messages.filter((msg) => {
			if (msg.role === "system") {
				// Handle system messages with both string and array content
				if (typeof msg.content === "string") {
					systemPrompt = msg.content;
				} else if (Array.isArray(msg.content)) {
					// For system messages, only extract text content
					const textContent = msg.content
						.filter((part) => part.type === "text")
						.map((part) => part.text || "")
						.join(" ");
					systemPrompt = textContent;
				}
				return false;
			}
			return true;
		});

		// Handle commands from system prompt (gives users control in limited UIs)
		const effortRegex = /reasoning_effort=(low|medium|high|none)\s*/i;
		const showRegex = /show_reasoning=(true|false)\s*/i;
		const cleanRegex = /clean_context=(true|false)\s*/i;
		const promptEffortMatch = systemPrompt.match(effortRegex);
		const promptShowMatch = systemPrompt.match(showRegex);
		const promptCleanMatch = systemPrompt.match(cleanRegex);
		let effortFromPrompt: string | null = null;
		let showReasoning = true; // Default to showing reasoning if it happens
		let cleanContext = true; // Default to cleaning the context

		if (promptEffortMatch) {
			effortFromPrompt = promptEffortMatch[1].toLowerCase();
			systemPrompt = systemPrompt.replace(effortRegex, "").trim(); // Clean the prompt
			console.log(`Reasoning effort '${effortFromPrompt}' detected in system prompt.`);
		}

		if (promptShowMatch) {
			showReasoning = promptShowMatch[1].toLowerCase() === "true";
			systemPrompt = systemPrompt.replace(showRegex, "").trim(); // Clean the prompt
			console.log(`Show reasoning set to '${showReasoning}' from system prompt.`);
		}

		if (promptCleanMatch) {
			cleanContext = promptCleanMatch[1].toLowerCase() === "true";
			systemPrompt = systemPrompt.replace(cleanRegex, "").trim(); // Clean the prompt
			console.log(`Clean context set to '${cleanContext}' from system prompt.`);
		}

		// Determine the final reasoning effort, giving precedence to the system prompt
		const reasoning_effort =
			effortFromPrompt || // Precedence for prompt
			body.reasoning_effort ||
			body.extra_body?.reasoning_effort ||
			body.model_params?.reasoning_effort;

		// Determine if reasoning should be included at all
		const isRealThinkingEnabled = c.env.ENABLE_REAL_THINKING === "true";
		const includeReasoning = reasoning_effort ? reasoning_effort !== "none" : isRealThinkingEnabled;

		// --- End Reasoning Configuration ---

		// Conditionally clean thinking blocks from the history before sending to the model
		const cleanedMessages = cleanContext ? stripThinkingBlocks(otherMessages) : otherMessages;

		// --- DEBUG: Log the cleaned messages to verify stripping ---
		// console.log("Cleaned messages being sent to model:", JSON.stringify(cleanedMessages, null, 2));
		// --- END DEBUG ---

		// Newly added parameters
		const generationOptions = {
			max_tokens: body.max_tokens,
			temperature: body.temperature,
			top_p: body.top_p,
			stop: body.stop,
			presence_penalty: body.presence_penalty,
			frequency_penalty: body.frequency_penalty,
			seed: body.seed,
			response_format: body.response_format
		};

		const tools = body.tools;
		const tool_choice = body.tool_choice;

		console.log("Request body parsed:", {
			model,
			messageCount: messages.length,
			stream,
			includeReasoning,
			reasoning_effort,
			tools,
			tool_choice
		});

		if (!messages.length) {
			return c.json({ error: "messages is a required field" }, 400);
		}

		// Validate model
		const modelValidation = validateModel(model);
		if (!modelValidation.isValid) {
			return c.json({ error: modelValidation.error }, 400);
		}

		// Unified media validation
		const mediaChecks: {
			type: string;
			supportKey: keyof ModelInfo;
			name: string;
		}[] = [
			{ type: "image_url", supportKey: "supportsImages", name: "image inputs" },
			{ type: "input_audio", supportKey: "supportsAudios", name: "audio inputs" },
			{ type: "input_video", supportKey: "supportsVideos", name: "video inputs" },
			{ type: "input_pdf", supportKey: "supportsPdfs", name: "PDF inputs" }
		];

		for (const { type, supportKey, name } of mediaChecks) {
			const messagesWithMedia = messages.filter(
				(msg) => Array.isArray(msg.content) && msg.content.some((content) => content.type === type)
			);

			if (messagesWithMedia.length > 0) {
				if (!isMediaTypeSupported(model, supportKey)) {
					return c.json(
						{
							error: `Model '${model}' does not support ${name}. Please use a model that supports this feature.`
						},
						400
					);
				}

				for (const msg of messagesWithMedia) {
					for (const content of msg.content as MessageContent[]) {
						if (content.type === type) {
							const { isValid, error } = validateContent(type, content);
							if (!isValid) {
								return c.json({ error }, 400);
							}
						}
					}
				}
			}
		}

		// Initialize services
		const authManager = new AuthManager(c.env);
		const geminiClient = new GeminiApiClient(c.env, authManager);

		// --- Smart Fallback Logic ---
		const smartManager = new SmartFallbackManager(c.env);
		let finalModel = model;
		let finalProjectId: string | null;

		if (SmartFallbackManager.isAutoModel(model)) {
			// This is a smart model, let the manager decide
			const decision = await smartManager.decide(model);
			finalModel = decision.model;
			finalProjectId = decision.projectId;

			// If the manager decided to use a dynamic project, we need to discover it.
			// If it decided on a personal project, projectIdHint is already set.
			if (decision.mode === 'dynamic') {
				finalProjectId = await geminiClient.discoverProjectId(null);
			}

		} else {
			// For specific models, decide based on whether a personal project ID is set
			if (c.env.GEMINI_PROJECT_ID) {
				finalProjectId = c.env.GEMINI_PROJECT_ID;
			} else {
				finalProjectId = await geminiClient.discoverProjectId(null);
			}
		}

		if (!finalProjectId) {
			return c.json({ error: "Could not determine a project ID to use." }, 500);
		}
		// --- End Smart Fallback Logic ---


		// Test authentication first
		try {
			await authManager.initializeAuth();
			console.log("Authentication successful");
		} catch (authError: unknown) {
			const errorMessage = authError instanceof Error ? authError.message : String(authError);
			console.error("Authentication failed:", errorMessage);
			return c.json({ error: "Authentication failed: " + errorMessage }, 401);
		}

		if (stream) {
			// Streaming response
			const { readable, writable } = new TransformStream();
			const writer = writable.getWriter();
			const openAITransformer = createOpenAIStreamTransformer(finalModel);
			const openAIStream = readable.pipeThrough(openAITransformer);

			// Asynchronously pipe data from Gemini to transformer
			(async () => {
				try {
					console.log("Starting stream generation with model:", finalModel);
					const geminiStream = geminiClient.streamContent(finalModel, finalProjectId!, systemPrompt, cleanedMessages, {
						includeReasoning,
						reasoning_effort: reasoning_effort || undefined, // Pass the string effort
						tools,
						tool_choice,
						showReasoning,
						...generationOptions
					});

					for await (const chunk of geminiStream) {
						await writer.write(chunk);
					}
					console.log("Stream completed successfully");
					await writer.close();
				} catch (streamError: any) {
					// --- Smart Fallback on Quota Error ---
					const isQuotaError = streamError.message?.includes("429");
					if (isQuotaError && SmartFallbackManager.isAutoModel(model) && decision.mode === 'dynamic') {
						console.log("Smart Fallback: Quota error detected on dynamic project.");
						try {
							const errorJson = JSON.parse(streamError.message.substring(streamError.message.indexOf('{')));
							const quotaResetTimestamp = errorJson?.error?.details?.[0]?.metadata?.quotaResetTimeStamp;
							
							if (quotaResetTimestamp) {
								await smartManager.setCooldown(quotaResetTimestamp);
								console.log("Smart Fallback: Cooldown set for future requests.");
							}
						} catch (e) {
							console.error("Smart Fallback: Failed to parse quota error or set cooldown.", e);
						}
					}
					// --- End Smart Fallback ---

					// Re-throw the original error to the client after attempting to set cooldown
					const errorMessage = streamError instanceof Error ? streamError.message : String(streamError);
					console.error("Stream error:", errorMessage);
					// Try to write an error chunk before closing
					await writer.write({
						type: "text",
						data: `Error: ${errorMessage}`
					});
					await writer.close();
				}
			})();

			// Return streaming response
			console.log("Returning streaming response");
			return new Response(openAIStream, {
				headers: {
					"Content-Type": "text/event-stream",
					"Cache-Control": "no-cache",
					Connection: "keep-alive"
				}
			});
		} else {
			// Non-streaming response
			// Note: Smart fallback is not implemented for non-streaming for simplicity.
			// It would require a similar try/catch and retry logic.
			try {
				console.log("Starting non-streaming completion");
				const completion = await geminiClient.getCompletion(finalModel, finalProjectId!, systemPrompt, cleanedMessages, {
					includeReasoning,
					reasoning_effort: reasoning_effort || undefined,
					tools,
					tool_choice,
					showReasoning,
					...generationOptions
				});

				const response: ChatCompletionResponse = {
					id: `chatcmpl-${crypto.randomUUID()}`,
					object: "chat.completion",
					created: Math.floor(Date.now() / 1000),
					model: model, // Return the original requested model
					choices: [
						{
							index: 0,
							message: {
								role: "assistant",
								content: completion.content,
								tool_calls: completion.tool_calls
							},
							finish_reason: completion.tool_calls && completion.tool_calls.length > 0 ? "tool_calls" : "stop"
						}
					]
				};

				// Add usage information if available
				if (completion.usage) {
					response.usage = {
						prompt_tokens: completion.usage.inputTokens,
						completion_tokens: completion.usage.outputTokens,
						total_tokens: completion.usage.inputTokens + completion.usage.outputTokens
					};
				}

				console.log("Non-streaming completion successful");
				return c.json(response);
			} catch (completionError: unknown) {
				const errorMessage = completionError instanceof Error ? completionError.message : String(completionError);
				console.error("Completion error:", errorMessage);
				return c.json({ error: errorMessage }, 500);
			}
		}
	} catch (e: unknown) {
		const errorMessage = e instanceof Error ? e.message : String(e);
		console.error("Top-level error:", e);
		return c.json({ error: errorMessage }, 500);
	}
});

// Audio transcriptions endpoint
OpenAIRoute.post("/audio/transcriptions", async (c) => {
	try {
		console.log("Audio transcription request received");
		const body = await c.req.parseBody();
		const file = body["file"];
		const model = (body["model"] as string) || DEFAULT_MODEL;
		const prompt = (body["prompt"] as string) || "Transcribe this audio in detail.";

		if (!file || !(file instanceof File)) {
			return c.json({ error: "File is required" }, 400);
		}

		// Validate model
		const modelValidation = validateModel(model);
		if (!modelValidation.isValid) {
			return c.json({ error: modelValidation.error }, 400);
		}

		let mimeType = file.type;

		// Fallback for application/octet-stream
		if (mimeType === "application/octet-stream" && file.name) {
			const ext = file.name.split(".").pop()?.toLowerCase();
			if (ext && MIME_TYPE_MAP[ext]) {
				mimeType = MIME_TYPE_MAP[ext];
				console.log(`Detected MIME type from extension .${ext}: ${mimeType}`);
			}
		}

		// Check for video or audio support based on MIME type
		const isVideo = mimeType.startsWith("video/");
		// gemini can generate transcriptions of videos too
		const isAudio = mimeType.startsWith("audio/");

		if (isVideo) {
			if (!isMediaTypeSupported(model, "supportsVideos")) {
				return c.json(
					{
						error: `Model '${model}' does not support video inputs.`
					},
					400
				);
			}
		} else if (isAudio) {
			if (!isMediaTypeSupported(model, "supportsAudios")) {
				return c.json(
					{
						error: `Model '${model}' does not support audio inputs.`
					},
					400
				);
			}
		} else {
			return c.json(
				{
					error: `Unsupported media type: ${mimeType}. Only audio and video files are supported.`
				},
				400
			);
		}

		// Convert File to base64
		const arrayBuffer = await file.arrayBuffer();
		console.log(`Processing audio file: size=${arrayBuffer.byteLength} bytes, type=${file.type}`);

		let base64Audio: string;
		try {
			base64Audio = Buffer.from(arrayBuffer).toString("base64");
		} catch (e: unknown) {
			const errorMessage = e instanceof Error ? e.message : String(e);
			console.error("Base64 conversion failed:", errorMessage);
			throw new Error(`Failed to process audio file: ${errorMessage}`);
		}

		// Construct message
		const messages: ChatMessage[] = [
			{
				role: "user",
				content: [
					{
						type: "text",
						text: prompt
					},
					{
						type: "input_audio",
						input_audio: {
							data: base64Audio,
							format: mimeType
						}
					}
				]
			}
		];

		// Initialize client
		const authManager = new AuthManager(c.env);
		const geminiClient = new GeminiApiClient(c.env, authManager);

		// Get completion
		const completion = await geminiClient.getCompletion(model, "", messages);

		return c.json({ text: completion.content });
	} catch (e: unknown) {
		const errorMessage = e instanceof Error ? e.message : String(e);
		console.error("Transcription error:", errorMessage);
		return c.json({ error: errorMessage }, 500);
	}
});
