import { Hono } from "hono";
import { Env, ChatCompletionRequest, ChatCompletionResponse } from "../types";
import { geminiCliModels, DEFAULT_MODEL, getAllModelIds } from "../models";
import { OPENAI_MODEL_OWNER } from "../config";
import { DEFAULT_THINKING_BUDGET } from "../constants";
import { AuthManager } from "../auth";
import { GeminiApiClient } from "../gemini-client";
import { createOpenAIStreamTransformer } from "../stream-transformer";

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
		if (!(model in geminiCliModels)) {
			return c.json(
				{
					error: `Model '${model}' not found. Available models: ${getAllModelIds().join(", ")}`
				},
				400
			);
		}

		// Check if the request contains images and validate model support
		const hasImages = messages.some((msg) => {
			if (Array.isArray(msg.content)) {
				return msg.content.some((content) => content.type === "image_url");
			}
			return false;
		});

		if (hasImages && !geminiCliModels[model].supportsImages) {
			return c.json(
				{
					error: `Model '${model}' does not support image inputs. Please use a vision-capable model like gemini-2.5-pro or gemini-2.5-flash.`
				},
				400
			);
		}

		// Initialize services
		const authManager = new AuthManager(c.env);
		const geminiClient = new GeminiApiClient(c.env, authManager);

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
			const openAITransformer = createOpenAIStreamTransformer(model);
			const openAIStream = readable.pipeThrough(openAITransformer);

			// Asynchronously pipe data from Gemini to transformer
			(async () => {
				try {
					console.log("Starting stream generation");
					const geminiStream = geminiClient.streamContent(model, systemPrompt, cleanedMessages, {
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
				} catch (streamError: unknown) {
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
			try {
				console.log("Starting non-streaming completion");
				const completion = await geminiClient.getCompletion(model, systemPrompt, cleanedMessages, {
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
					model: model,
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