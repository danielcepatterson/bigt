import { Hono } from "hono";
import { cors } from "hono/cors";

// ==================== TYPES ====================

export type Message = { role: "user" | "assistant" | "system"; content: string };

export type Memory = {
	id: string;
	content: string;
	category: "personal" | "preference" | "goal" | "technical" | "context" | "general";
	timestamp: string;
};

export type Task = {
	id: string;
	content: string;
	done: boolean;
	created: string;
	due?: string;
	priority?: "low" | "medium" | "high";
};

export type ConversationMeta = {
	id: string;
	title: string;
	created: string;
	updated: string;
	messageCount: number;
};

export type ChatRequest = {
	messages: Message[];
	conversationId?: string;
};

export type ChatResponse = {
	response: string;
	conversationId: string;
	toolsUsed?: string[];
};

// ==================== KV HELPERS ====================

async function getMemories(env: Env): Promise<Memory[]> {
	const raw = await env.MEMORY.get("memories");
	return raw ? JSON.parse(raw) : [];
}

async function saveMemories(env: Env, memories: Memory[]): Promise<void> {
	await env.MEMORY.put("memories", JSON.stringify(memories));
}

async function getTasks(env: Env): Promise<Task[]> {
	const raw = await env.MEMORY.get("tasks");
	return raw ? JSON.parse(raw) : [];
}

async function getConversation(env: Env, id: string): Promise<Message[]> {
	const raw = await env.MEMORY.get(`conv:${id}`);
	return raw ? JSON.parse(raw) : [];
}

async function getUserProfile(env: Env): Promise<Record<string, string>> {
	const raw = await env.MEMORY.get("user:profile");
	return raw ? JSON.parse(raw) : {};
}

async function updateUserProfile(env: Env, updates: Record<string, string>): Promise<void> {
	const profile = await getUserProfile(env);
	await env.MEMORY.put("user:profile", JSON.stringify({ ...profile, ...updates }));
}

// ==================== SYSTEM PROMPT ====================

async function buildSystemPrompt(env: Env): Promise<string> {
	const [memories, tasks, profile] = await Promise.all([
		getMemories(env),
		getTasks(env),
		getUserProfile(env),
	]);

	const now = new Date();
	const dateStr =
		now.toLocaleString("en-US", {
			timeZone: "UTC",
			weekday: "long",
			year: "numeric",
			month: "long",
			day: "numeric",
			hour: "2-digit",
			minute: "2-digit",
		}) + " UTC";

	const pendingTasks = tasks.filter((t) => !t.done);

	const model = env.OPENAI_API_KEY
		? "GPT-4o (OpenAI)"
		: "Llama 3.3 70B Instruct FP8 Fast (Cloudflare Workers AI — @cf/meta/llama-3.3-70b-instruct-fp8-fast)";

	let prompt = `You are bigT — a persistent, learning AI personal assistant running on Cloudflare Workers.

Your technical details (answer these directly when asked):
- AI model: ${model}
- Infrastructure: Cloudflare Workers (edge compute), Cloudflare KV (persistent memory), Hono (API framework), React frontend
- Memory: persistent across all conversations via Cloudflare KV — you genuinely remember things
- Tools: web_search (DuckDuckGo + Brave), fetch_url, save_memory, update_profile, create_task, complete_task, delete_task
- Voice: Web Speech API for both input and output
- Deployed at: Cloudflare's global edge network

Current time: ${dateStr}`;

	if (Object.keys(profile).length > 0) {
		prompt += `\n\nUser profile:\n${Object.entries(profile)
			.map(([k, v]) => `  ${k}: ${v}`)
			.join("\n")}`;
	}

	if (memories.length > 0) {
		const recent = memories.slice(-30);
		prompt += `\n\nLong-term memory (${memories.length} total, showing latest ${recent.length}):\n${recent
			.map((m) => `  [${m.category}] ${m.content}`)
			.join("\n")}`;
	}

	if (pendingTasks.length > 0) {
		prompt += `\n\nPending tasks (${pendingTasks.length}):\n${pendingTasks
			.slice(0, 15)
			.map(
				(t) =>
					`  - [${t.priority ?? "medium"}] ${t.content}${t.due ? ` (due: ${t.due})` : ""}`,
			)
			.join("\n")}`;
	}

	prompt += `

You have access to tools. Call them by embedding a JSON block exactly like this in your response — one per line:
<TOOL>{"tool":"web_search","query":"your query"}</TOOL>
<TOOL>{"tool":"search_and_fetch","query":"your query"}</TOOL>
<TOOL>{"tool":"fetch_url","url":"https://example.com"}</TOOL>
<TOOL>{"tool":"save_memory","content":"fact to remember","category":"personal|preference|goal|technical|context|general"}</TOOL>
<TOOL>{"tool":"update_profile","key":"name|timezone|occupation|etc","value":"value"}</TOOL>
<TOOL>{"tool":"create_task","content":"description","priority":"low|medium|high","due":"YYYY-MM-DD"}</TOOL>
<TOOL>{"tool":"complete_task","id":"task-id"}</TOOL>
<TOOL>{"tool":"delete_task","id":"task-id"}</TOOL>

Tool guidance:
- Use search_and_fetch for specific factual questions (hours, prices, addresses, menus, events, people, places). It searches AND reads the top result page automatically — always prefer this over plain web_search for specific lookups.
- Use web_search only for broad queries where snippets are enough.
- Use fetch_url when you already have a URL you want to read.

Core rules — follow these exactly:
1. ANSWER THE QUESTION FIRST. Always. Never deflect, hedge, or redirect before giving the actual answer.
2. Never say "Certainly", "Of course", "Great question", "I'd be happy to" or any filler. Start with the answer.
3. If you don't know something current, use search_and_fetch immediately — never tell the user to check somewhere themselves.
4. NEVER say "I was unable to find" or "you might want to check" — if the first search fails, try a different query or fetch a different URL. Try at least twice before giving up.
5. Save memories only for durable, important facts about the user.
6. When asked about yourself — answer from your technical details above, directly.
7. Use markdown only for genuinely complex content. Plain prose for casual replies.
8. Be concise. Report what you found, not the process of finding it.`;

	return prompt;
}

// ==================== TOOL EXECUTION ====================

async function executeTool(env: Env, toolCall: Record<string, string>): Promise<string> {
	const { tool } = toolCall;

	if (tool === "web_search") {
		const query = toolCall.query;
		const braveKey = env.BRAVE_API_KEY;

		// Try Brave first if key is available
		if (braveKey) {
			try {
				const res = await fetch(
					`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=8&search_lang=en`,
					{ headers: { Accept: "application/json", "X-Subscription-Token": braveKey } },
				);
				if (res.ok) {
					const data = (await res.json()) as {
						web?: { results?: Array<{ title: string; description: string; url: string }> };
					};
					const results =
						data.web?.results
							?.slice(0, 8)
							.map((r) => `**${r.title}**\n${r.description}\n${r.url}`)
							.join("\n\n") || "No results.";
					return `Brave search results for "${query}":\n\n${results}`;
				}
			} catch {}
		}

		// Fallback 1: DuckDuckGo JSON API (official, no key, no bot issues)
		try {
			const ddgRes = await fetch(
				`https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`,
				{
					headers: { Accept: "application/json" },
					signal: AbortSignal.timeout(8000),
				},
			);
			if (ddgRes.ok) {
				type DDGResult = { Text: string; FirstURL: string };
				type DDGResponse = {
					Abstract?: string;
					AbstractSource?: string;
					AbstractURL?: string;
					Answer?: string;
					RelatedTopics?: Array<DDGResult | { Topics?: DDGResult[] }>;
				};
				const data = (await ddgRes.json()) as DDGResponse;
				const parts: string[] = [];

				if (data.Answer) parts.push(`**Direct answer:** ${data.Answer}`);
				if (data.Abstract) parts.push(`**${data.AbstractSource}:** ${data.Abstract}\n${data.AbstractURL}`);

				const topics: DDGResult[] = [];
				for (const t of data.RelatedTopics ?? []) {
					if ("Topics" in t && t.Topics) topics.push(...t.Topics);
					else if ("Text" in t) topics.push(t as DDGResult);
				}
				for (const t of topics.slice(0, 6)) {
					if (t.Text) parts.push(`- ${t.Text}${t.FirstURL ? `\n  ${t.FirstURL}` : ""}`);
				}

				if (parts.length > 0) {
					return `DuckDuckGo results for "${query}":\n\n${parts.join("\n\n")}`;
				}
			}
		} catch {}

		// Fallback 2: SearXNG public instances (try each until one works)
		const searxInstances = [
			"https://searx.be",
			"https://search.mdosch.de",
			"https://searxng.site",
			"https://priv.au",
		];
		for (const instance of searxInstances) {
			try {
				const url = `${instance}/search?q=${encodeURIComponent(query)}&format=json&language=en`;
				const res = await fetch(url, {
					headers: {
						"User-Agent": "Mozilla/5.0 (X11; Linux x86_64; rv:124.0) Gecko/20100101 Firefox/124.0",
						Accept: "application/json",
					},
					signal: AbortSignal.timeout(7000),
				});
				if (!res.ok) continue;
				type SearXResult = { title: string; content: string; url: string };
				const data = (await res.json()) as { results?: SearXResult[] };
				if (!data.results?.length) continue;
				const results = data.results
					.slice(0, 8)
					.map((r) => `**${r.title}**\n${r.content}\n${r.url}`)
					.join("\n\n");
				return `Search results for "${query}" (via ${instance}):\n\n${results}`;
			} catch {}
		}

		return `All search engines failed for "${query}". If this keeps happening, add a BRAVE_API_KEY secret for reliable search.`;
	}

	if (tool === "fetch_url") {
		try {
			const res = await fetch(toolCall.url, {
				headers: {
					"User-Agent": "Mozilla/5.0 (X11; Linux x86_64; rv:124.0) Gecko/20100101 Firefox/124.0",
					"Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
					"Accept-Language": "en-US,en;q=0.5",
				},
				signal: AbortSignal.timeout(12000),
			});
			if (!res.ok) return `Failed to fetch ${toolCall.url}: HTTP ${res.status}`;
			const html = await res.text();
			const clean = html
				.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
				.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
				.replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, "")
				.replace(/<header[^>]*>[\s\S]*?<\/header>/gi, "")
				.replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, "")
				.replace(/<[^>]+>/g, " ")
				.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
				.replace(/&nbsp;/g, " ").replace(/&#\d+;/g, " ")
				.replace(/\s{3,}/g, "\n")
				.trim()
				.slice(0, 5000);
			return `Content from ${toolCall.url}:\n\n${clean}`;
		} catch (e) {
			return `Failed to fetch URL: ${String(e)}`;
		}
	}

	if (tool === "search_and_fetch") {
		// Step 1: run a web search and collect URLs
		const searchResult = await executeTool(env, { tool: "web_search", query: toolCall.query });

		// Extract all URLs from the search result text
		const urlMatches = searchResult.match(/https?:\/\/[^\s)"'<>]+/g) ?? [];
		// Filter out search engine URLs themselves, prefer .com/.org/.net/local business domains
		const candidates = urlMatches.filter(
			(u) => !u.includes("duckduckgo") && !u.includes("searx") && !u.includes("brave.com/search"),
		);

		if (candidates.length === 0) {
			return searchResult; // return search text as-is if no URLs to follow
		}

		// Step 2: fetch the top candidate URL
		const topUrl = candidates[0];
		const pageResult = await executeTool(env, { tool: "fetch_url", url: topUrl });

		return `Search results for "${toolCall.query}":\n${searchResult}\n\n---\nPage content from ${topUrl}:\n${pageResult}`;
	}
		const memories = await getMemories(env);
		const duplicate = memories.find(
			(m) => m.content.toLowerCase().trim() === toolCall.content.toLowerCase().trim(),
		);
		if (duplicate) return `Memory already exists: "${toolCall.content}"`;
		const memory: Memory = {
			id: crypto.randomUUID(),
			content: toolCall.content,
			category: (toolCall.category as Memory["category"]) || "general",
			timestamp: new Date().toISOString(),
		};
		memories.push(memory);
		await saveMemories(env, memories);
		return `Memory saved: "${toolCall.content}" [${memory.category}]`;
	}

	if (tool === "update_profile") {
		await updateUserProfile(env, { [toolCall.key]: toolCall.value });
		return `Profile updated: ${toolCall.key} = "${toolCall.value}"`;
	}

	if (tool === "create_task") {
		const tasks = await getTasks(env);
		const task: Task = {
			id: crypto.randomUUID(),
			content: toolCall.content,
			done: false,
			created: new Date().toISOString(),
			due: toolCall.due,
			priority: (toolCall.priority as Task["priority"]) || "medium",
		};
		tasks.push(task);
		await env.MEMORY.put("tasks", JSON.stringify(tasks));
		return `Task created [${task.priority}]: "${task.content}"${task.due ? ` due ${task.due}` : ""}`;
	}

	if (tool === "complete_task") {
		const tasks = await getTasks(env);
		const idx = tasks.findIndex((t) => t.id === toolCall.id);
		if (idx >= 0) {
			tasks[idx].done = true;
			await env.MEMORY.put("tasks", JSON.stringify(tasks));
			return `Task completed: "${tasks[idx].content}"`;
		}
		return `Task not found: ${toolCall.id}`;
	}

	if (tool === "delete_task") {
		const tasks = await getTasks(env);
		await env.MEMORY.put("tasks", JSON.stringify(tasks.filter((t) => t.id !== toolCall.id)));
		return `Task deleted.`;
	}

	return `Unknown tool: ${tool}`;
}

// ==================== LLM CALL ====================

async function callAI(env: Env, messages: Message[]): Promise<string> {
	if (env.OPENAI_API_KEY) {
		const res = await fetch("https://api.openai.com/v1/chat/completions", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${env.OPENAI_API_KEY}`,
			},
			body: JSON.stringify({
				model: "gpt-4o",
				messages,
				max_tokens: 2048,
				temperature: 0.7,
			}),
		});
		if (res.ok) {
			const data = (await res.json()) as {
				choices: Array<{ message: { content: string } }>;
			};
			return data.choices[0]?.message?.content ?? "";
		}
	}

	// Fallback: Cloudflare Workers AI
	const response = (await env.AI.run(
		"@cf/meta/llama-3.3-70b-instruct-fp8-fast" as Parameters<Ai["run"]>[0],
		{ messages, max_tokens: 2048 },
	)) as { response?: string };

	return response.response ?? "";
}

// ==================== ROUTES ====================

const app = new Hono<{ Bindings: Env }>();

app.use("/api/*", cors());

// ── Chat ──────────────────────────────────────────────────────────────────────

app.post("/api/chat", async (c) => {
	try {
		const body = await c.req.json<ChatRequest>();
		const { messages, conversationId } = body;
		const convId = conversationId ?? crypto.randomUUID();

		const history = conversationId ? await getConversation(c.env, conversationId) : [];
		const systemPrompt = await buildSystemPrompt(c.env);

		const allMessages: Message[] = [
			{ role: "system", content: systemPrompt },
			...history.slice(-30),
			...messages,
		];

		let responseText = await callAI(c.env, allMessages);
		const toolsUsed: string[] = [];

		// Agentic tool loop — up to 5 rounds
		for (let round = 0; round < 5; round++) {
			const toolMatches = [...responseText.matchAll(/<TOOL>(\{.*?\})<\/TOOL>/gs)];
			if (toolMatches.length === 0) break;

			const toolResults: string[] = [];
			for (const match of toolMatches) {
				try {
					const toolCall = JSON.parse(match[1]) as Record<string, string>;
					toolsUsed.push(toolCall.tool);
					const result = await executeTool(c.env, toolCall);
					toolResults.push(`[${toolCall.tool} result]\n${result}`);
				} catch (e) {
					toolResults.push(`[tool parse error: ${String(e)}]`);
				}
			}

			const strippedResponse = responseText.replace(/<TOOL>.*?<\/TOOL>/gs, "").trim();

			const followUpMessages: Message[] = [
				...allMessages,
				{ role: "assistant", content: strippedResponse || "(executing tools)" },
				{
					role: "user",
					content: `Tool results:\n\n${toolResults.join("\n\n")}\n\nNow provide your final response to the user based on these results. Do not mention tool mechanics — just respond naturally.`,
				},
			];

			responseText = await callAI(c.env, followUpMessages);
		}

		const cleanResponse = responseText.replace(/<TOOL>.*?<\/TOOL>/gs, "").trim();

		// Persist conversation asynchronously
		c.executionCtx.waitUntil(
			(async () => {
				const updatedHistory: Message[] = [
					...history,
					...messages,
					{ role: "assistant", content: cleanResponse },
				];
				await c.env.MEMORY.put(`conv:${convId}`, JSON.stringify(updatedHistory));

				const listRaw = await c.env.MEMORY.get("conversations:list");
				const list: ConversationMeta[] = listRaw ? JSON.parse(listRaw) : [];
				const existingIdx = list.findIndex((cv) => cv.id === convId);
				const firstMsg =
					messages[0]?.content ?? history[0]?.content ?? "New conversation";

				if (existingIdx >= 0) {
					list[existingIdx].updated = new Date().toISOString();
					list[existingIdx].messageCount = updatedHistory.length;
				} else {
					list.unshift({
						id: convId,
						title: firstMsg.slice(0, 70) + (firstMsg.length > 70 ? "…" : ""),
						created: new Date().toISOString(),
						updated: new Date().toISOString(),
						messageCount: updatedHistory.length,
					});
				}

				await c.env.MEMORY.put(
					"conversations:list",
					JSON.stringify(list.slice(0, 100)),
				);
			})(),
		);

		const result: ChatResponse = {
			response: cleanResponse,
			conversationId: convId,
			toolsUsed,
		};
		return c.json(result);
	} catch (err) {
		console.error("Chat error:", err);
		return c.json({ error: String(err) }, 500);
	}
});

// ── Memory ────────────────────────────────────────────────────────────────────

app.get("/api/memories", async (c) => c.json(await getMemories(c.env)));

app.post("/api/memories", async (c) => {
	const body = await c.req.json<{ content: string; category?: Memory["category"] }>();
	const memories = await getMemories(c.env);
	const memory: Memory = {
		id: crypto.randomUUID(),
		content: body.content,
		category: body.category ?? "general",
		timestamp: new Date().toISOString(),
	};
	memories.push(memory);
	await saveMemories(c.env, memories);
	return c.json(memory, 201);
});

app.delete("/api/memories/:id", async (c) => {
	const memories = await getMemories(c.env);
	await saveMemories(c.env, memories.filter((m) => m.id !== c.req.param("id")));
	return c.json({ success: true });
});

app.delete("/api/memories", async (c) => {
	await saveMemories(c.env, []);
	return c.json({ success: true });
});

// ── Tasks ─────────────────────────────────────────────────────────────────────

app.get("/api/tasks", async (c) => c.json(await getTasks(c.env)));

app.post("/api/tasks", async (c) => {
	const body = await c.req.json<{
		content: string;
		due?: string;
		priority?: Task["priority"];
	}>();
	const tasks = await getTasks(c.env);
	const task: Task = {
		id: crypto.randomUUID(),
		content: body.content,
		done: false,
		created: new Date().toISOString(),
		due: body.due,
		priority: body.priority ?? "medium",
	};
	tasks.push(task);
	await c.env.MEMORY.put("tasks", JSON.stringify(tasks));
	return c.json(task, 201);
});

app.patch("/api/tasks/:id", async (c) => {
	const id = c.req.param("id");
	const body = await c.req.json<Partial<Task>>();
	const tasks = await getTasks(c.env);
	const idx = tasks.findIndex((t) => t.id === id);
	if (idx < 0) return c.json({ error: "Not found" }, 404);
	tasks[idx] = { ...tasks[idx], ...body };
	await c.env.MEMORY.put("tasks", JSON.stringify(tasks));
	return c.json(tasks[idx]);
});

app.delete("/api/tasks/:id", async (c) => {
	const tasks = await getTasks(c.env);
	await c.env.MEMORY.put(
		"tasks",
		JSON.stringify(tasks.filter((t) => t.id !== c.req.param("id"))),
	);
	return c.json({ success: true });
});

// ── Conversations ─────────────────────────────────────────────────────────────

app.get("/api/conversations", async (c) => {
	const raw = await c.env.MEMORY.get("conversations:list");
	return c.json(raw ? JSON.parse(raw) : []);
});

app.get("/api/conversations/:id", async (c) => {
	return c.json(await getConversation(c.env, c.req.param("id")));
});

app.delete("/api/conversations/:id", async (c) => {
	const id = c.req.param("id");
	await c.env.MEMORY.delete(`conv:${id}`);
	const raw = await c.env.MEMORY.get("conversations:list");
	const list = raw ? JSON.parse(raw) : [];
	await c.env.MEMORY.put(
		"conversations:list",
		JSON.stringify(list.filter((cv: ConversationMeta) => cv.id !== id)),
	);
	return c.json({ success: true });
});

// ── Profile ───────────────────────────────────────────────────────────────────

app.get("/api/profile", async (c) => c.json(await getUserProfile(c.env)));

app.patch("/api/profile", async (c) => {
	const body = await c.req.json<Record<string, string>>();
	await updateUserProfile(c.env, body);
	return c.json(await getUserProfile(c.env));
});

// ── Status ────────────────────────────────────────────────────────────────────

app.get("/api/status", async (c) => {
	const [memories, tasks, convListRaw] = await Promise.all([
		getMemories(c.env),
		getTasks(c.env),
		c.env.MEMORY.get("conversations:list"),
	]);
	const convList = convListRaw ? JSON.parse(convListRaw) : [];
	return c.json({
		status: "online",
		memories: memories.length,
		pendingTasks: tasks.filter((t) => !t.done).length,
		conversations: convList.length,
		model: c.env.OPENAI_API_KEY
			? "gpt-4o"
			: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
		timestamp: new Date().toISOString(),
	});
});

export default app;
