// src/react-app/App.tsx — JARVIS Interface

import { useState, useEffect, useRef, useCallback } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import "./App.css";

// ── Types ─────────────────────────────────────────────────────────────────────

type Role = "user" | "assistant" | "system";
type Message = { role: Role; content: string; id: string; toolsUsed?: string[] };

type Memory = {
	id: string;
	content: string;
	category: string;
	timestamp: string;
};

type Task = {
	id: string;
	content: string;
	done: boolean;
	created: string;
	due?: string;
	priority?: "low" | "medium" | "high";
};

type ConversationMeta = {
	id: string;
	title: string;
	created: string;
	updated: string;
	messageCount: number;
};

type Status = {
	status: string;
	memories: number;
	pendingTasks: number;
	conversations: number;
	model: string;
	timestamp: string;
};

type Panel = "none" | "memory" | "tasks" | "conversations" | "profile";

// ── Helpers ───────────────────────────────────────────────────────────────────

function uid() {
	return Math.random().toString(36).slice(2);
}

// ── Main App ──────────────────────────────────────────────────────────────────

export default function App() {
	const [messages, setMessages] = useState<Message[]>([]);
	const [input, setInput] = useState("");
	const [loading, setLoading] = useState(false);
	const [conversationId, setConversationId] = useState<string | undefined>(undefined);
	const [panel, setPanel] = useState<Panel>("none");

	const [memories, setMemories] = useState<Memory[]>([]);
	const [tasks, setTasks] = useState<Task[]>([]);
	const [conversations, setConversations] = useState<ConversationMeta[]>([]);
	const [status, setStatus] = useState<Status | null>(null);
	const [profile, setProfile] = useState<Record<string, string>>({});

	const [newMemory, setNewMemory] = useState("");
	const [newMemoryCat, setNewMemoryCat] = useState("general");
	const [newTask, setNewTask] = useState("");
	const [newTaskPriority, setNewTaskPriority] = useState<Task["priority"]>("medium");
	const [newTaskDue, setNewTaskDue] = useState("");

	const [profileKey, setProfileKey] = useState("");
	const [profileValue, setProfileValue] = useState("");
	const [showModel, setShowModel] = useState(false);

	const [listening, setListening] = useState(false);
	const [speaking, setSpeaking] = useState(false);
	const [interimTranscript, setInterimTranscript] = useState("");

	const bottomRef = useRef<HTMLDivElement>(null);
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	const recognitionRef = useRef<SpeechRecognition | null>(null);

	// ── Init ───────────────────────────────────────────────────────────────────

	useEffect(() => {
		fetchStatus();
	}, []);

	useEffect(() => {
		bottomRef.current?.scrollIntoView({ behavior: "smooth" });
	}, [messages, loading]);

	// ── Panel Data ─────────────────────────────────────────────────────────────

	useEffect(() => {
		if (panel === "memory") fetchMemories();
		if (panel === "tasks") fetchTasks();
		if (panel === "conversations") fetchConversations();
		if (panel === "profile") fetchProfile();
	}, [panel]);

	async function fetchStatus() {
		try {
			const res = await fetch("/api/status");
			if (res.ok) setStatus(await res.json());
		} catch {}
	}

	async function fetchMemories() {
		const res = await fetch("/api/memories");
		if (res.ok) setMemories(await res.json());
	}

	async function fetchTasks() {
		const res = await fetch("/api/tasks");
		if (res.ok) setTasks(await res.json());
	}

	async function fetchConversations() {
		const res = await fetch("/api/conversations");
		if (res.ok) setConversations(await res.json());
	}

	async function fetchProfile() {
		const res = await fetch("/api/profile");
		if (res.ok) setProfile(await res.json());
	}

	// ── Chat ───────────────────────────────────────────────────────────────────

	const sendMessage = useCallback(
		async (text?: string) => {
			const content = (text ?? input).trim();
			if (!content || loading) return;

			setInput("");
			const userMsg: Message = { role: "user", content, id: uid() };
			setMessages((prev) => [...prev, userMsg]);
			setLoading(true);

			try {
				const res = await fetch("/api/chat", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						messages: [{ role: "user", content }],
						conversationId,
					}),
				});

				const data = (await res.json()) as {
					response: string;
					conversationId: string;
					toolsUsed?: string[];
					error?: string;
				};

				if (data.error) throw new Error(data.error);

				setConversationId(data.conversationId);
				const assistantMsg: Message = {
					role: "assistant",
					content: data.response,
					id: uid(),
					toolsUsed: data.toolsUsed,
				};
				setMessages((prev) => [...prev, assistantMsg]);

				// Speak response
				speakText(data.response);

				// Refresh status
				fetchStatus();
			} catch (err) {
				setMessages((prev) => [
					...prev,
					{
						role: "assistant",
						content: `System error: ${String(err)}`,
						id: uid(),
					},
				]);
			} finally {
				setLoading(false);
			}
		},
		[input, loading, conversationId],
	);

	function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
		if (e.key === "Enter" && !e.shiftKey) {
			e.preventDefault();
			sendMessage();
		}
	}

	// ── Voice I/O ──────────────────────────────────────────────────────────────

	function startListening() {
		const SpeechRecognition =
			window.SpeechRecognition || (window as unknown as { webkitSpeechRecognition: typeof SpeechRecognition }).webkitSpeechRecognition;
		if (!SpeechRecognition) {
			alert("Speech recognition not supported in this browser. Try Chrome or Edge.");
			return;
		}

		const rec = new SpeechRecognition();
		rec.continuous = true;
		rec.interimResults = true;
		rec.lang = "en-US";
		recognitionRef.current = rec;

		let finalText = "";
		let silenceTimer: ReturnType<typeof setTimeout> | null = null;

		rec.onresult = (e) => {
			let interim = "";
			finalText = "";
			for (let i = 0; i < e.results.length; i++) {
				if (e.results[i].isFinal) {
					finalText += e.results[i][0].transcript;
				} else {
					interim += e.results[i][0].transcript;
				}
			}
			setInterimTranscript(interim);
			if (finalText) setInput(finalText);

			// Auto-send after 1.5s of silence following final result
			if (finalText) {
				if (silenceTimer) clearTimeout(silenceTimer);
				silenceTimer = setTimeout(() => {
					rec.stop();
					setInterimTranscript("");
					setListening(false);
					if (finalText.trim()) {
						sendMessage(finalText.trim());
						setInput("");
					}
				}, 1500);
			}
		};

		rec.onerror = (e) => {
			if (e.error !== "aborted") console.warn("Speech error:", e.error);
			if (silenceTimer) clearTimeout(silenceTimer);
			setInterimTranscript("");
			setListening(false);
		};

		rec.onend = () => {
			if (silenceTimer) clearTimeout(silenceTimer);
			setInterimTranscript("");
			setListening(false);
		};

		rec.start();
		setListening(true);
	}

	function stopListening() {
		recognitionRef.current?.stop();
		setInterimTranscript("");
		setListening(false);
	}

	function speakText(text: string) {
		if (!window.speechSynthesis) return;
		window.speechSynthesis.cancel();
		// Strip markdown for TTS
		const plain = text
			.replace(/```[\s\S]*?```/g, "")
			.replace(/`[^`]+`/g, "")
			.replace(/#{1,6}\s/g, "")
			.replace(/[*_~>|]/g, "")
			.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
			.replace(/\n{2,}/g, ". ")
			.replace(/\n/g, " ")
			.trim()
			.slice(0, 1200);

		const utterance = new SpeechSynthesisUtterance(plain);
		utterance.rate = 1.0;
		utterance.pitch = 0.85;

		// Pick the best available voice — prefer deep/natural English
		const voices = window.speechSynthesis.getVoices();
		const preferred = [
			"Google UK English Male",
			"Microsoft Ryan Online (Natural) - English (United Kingdom)",
			"Microsoft Guy Online (Natural) - English (United States)",
			"Alex",
			"Daniel",
		];
		for (const name of preferred) {
			const v = voices.find((v) => v.name === name);
			if (v) { utterance.voice = v; break; }
		}
		if (!utterance.voice) {
			utterance.voice = voices.find((v) => v.lang.startsWith("en") && !v.localService === false) ??
				voices.find((v) => v.lang.startsWith("en")) ?? null;
		}

		utterance.onstart = () => setSpeaking(true);
		utterance.onend = () => setSpeaking(false);
		utterance.onerror = () => setSpeaking(false);
		window.speechSynthesis.speak(utterance);
	}

	function stopSpeaking() {
		window.speechSynthesis?.cancel();
		setSpeaking(false);
	}

	// ── Conversations ──────────────────────────────────────────────────────────

	async function loadConversation(id: string) {
		const res = await fetch(`/api/conversations/${id}`);
		if (!res.ok) return;
		const msgs = (await res.json()) as Array<{ role: Role; content: string }>;
		setMessages(msgs.map((m) => ({ ...m, id: uid() })));
		setConversationId(id);
		setPanel("none");
	}

	async function deleteConversation(id: string) {
		await fetch(`/api/conversations/${id}`, { method: "DELETE" });
		setConversations((prev) => prev.filter((c) => c.id !== id));
		if (conversationId === id) {
			setMessages([]);
			setConversationId(undefined);
		}
	}

	function newConversation() {
		setMessages([]);
		setConversationId(undefined);
		setPanel("none");
	}

	// ── Memory ─────────────────────────────────────────────────────────────────

	async function addMemory() {
		if (!newMemory.trim()) return;
		const res = await fetch("/api/memories", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ content: newMemory, category: newMemoryCat }),
		});
		if (res.ok) {
			setNewMemory("");
			fetchMemories();
			fetchStatus();
		}
	}

	async function deleteMemory(id: string) {
		await fetch(`/api/memories/${id}`, { method: "DELETE" });
		setMemories((prev) => prev.filter((m) => m.id !== id));
		fetchStatus();
	}

	// ── Tasks ──────────────────────────────────────────────────────────────────

	async function addTask() {
		if (!newTask.trim()) return;
		await fetch("/api/tasks", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				content: newTask,
				priority: newTaskPriority,
				due: newTaskDue || undefined,
			}),
		});
		setNewTask("");
		setNewTaskDue("");
		fetchTasks();
		fetchStatus();
	}

	async function toggleTask(task: Task) {
		await fetch(`/api/tasks/${task.id}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ done: !task.done }),
		});
		fetchTasks();
		fetchStatus();
	}

	async function deleteTask(id: string) {
		await fetch(`/api/tasks/${id}`, { method: "DELETE" });
		setTasks((prev) => prev.filter((t) => t.id !== id));
		fetchStatus();
	}

	// ── Profile ────────────────────────────────────────────────────────────────

	async function addProfileEntry() {
		if (!profileKey.trim() || !profileValue.trim()) return;
		await fetch("/api/profile", {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ [profileKey]: profileValue }),
		});
		setProfileKey("");
		setProfileValue("");
		fetchProfile();
	}

	// ── Render ─────────────────────────────────────────────────────────────────

	const pendingTasks = tasks.filter((t) => !t.done);
	const doneTasks = tasks.filter((t) => t.done);

	return (
		<div className="jarvis-root">
			{/* ── Ambient glow ── */}
			<div className="ambient-glow" />

			{/* ── Header ── */}
			<header className="jarvis-header">
				<div className="header-left">
					<div className="arc-reactor">
						<div className="arc-inner" />
					</div>
					<div className="header-title">
					<span className="jarvis-logo">bigT</span>

					</div>
				</div>

				{status && (
					<div className="status-bar">
						<span className={`status-dot ${status.status === "online" ? "online" : "offline"}`} />
						<span className="status-item">
							<span className="status-label">MODEL</span>
							<button className="model-toggle-btn" onClick={() => setShowModel((v) => !v)}>
								{showModel ? status.model.split("/").pop() : "···"}
							</button>
						</span>
						<span className="status-item">
							<span className="status-label">MEMORIES</span>
							<span className="status-value">{status.memories}</span>
						</span>
						<span className="status-item">
							<span className="status-label">TASKS</span>
							<span className="status-value">{status.pendingTasks}</span>
						</span>
						<span className="status-item">
							<span className="status-label">CONVS</span>
							<span className="status-value">{status.conversations}</span>
						</span>
					</div>
				)}

				<nav className="header-nav">
					{(["conversations", "memory", "tasks", "profile"] as Panel[]).map((p) => (
						<button
							key={p}
							className={`nav-btn ${panel === p ? "active" : ""}`}
							onClick={() => setPanel(panel === p ? "none" : p)}
						>
							{p === "conversations" && "⟳"}
							{p === "memory" && "◈"}
							{p === "tasks" && "◻"}
							{p === "profile" && "◎"}
							<span>{p.toUpperCase()}</span>
						</button>
					))}
					<button className="nav-btn new-conv" onClick={newConversation} title="New conversation">
						＋
					</button>
				</nav>
			</header>

			<div className="jarvis-body">
				{/* ── Side Panel ── */}
				{panel !== "none" && (
					<aside className="side-panel">
						<div className="panel-header">
							<h2>{panel.toUpperCase()}</h2>
							<button className="close-btn" onClick={() => setPanel("none")}>✕</button>
						</div>

						{/* Conversations */}
						{panel === "conversations" && (
							<div className="panel-content">
								{conversations.length === 0 && (
									<p className="empty-state">No saved conversations yet.</p>
								)}
								{conversations.map((cv) => (
									<div key={cv.id} className={`conv-item ${cv.id === conversationId ? "active" : ""}`}>
										<div className="conv-title" onClick={() => loadConversation(cv.id)}>
											{cv.title}
										</div>
										<div className="conv-meta">
											{cv.messageCount} msgs · {new Date(cv.updated).toLocaleDateString()}
										</div>
										<button
											className="delete-btn"
											onClick={() => deleteConversation(cv.id)}
										>
											✕
										</button>
									</div>
								))}
							</div>
						)}

						{/* Memory */}
						{panel === "memory" && (
							<div className="panel-content">
								<div className="add-row">
									<select
										value={newMemoryCat}
										onChange={(e) => setNewMemoryCat(e.target.value)}
										className="cat-select"
									>
										{["general", "personal", "preference", "goal", "technical", "context"].map(
											(c) => (
												<option key={c} value={c}>
													{c}
												</option>
											),
										)}
									</select>
									<input
										className="panel-input"
										placeholder="Add memory..."
										value={newMemory}
										onChange={(e) => setNewMemory(e.target.value)}
										onKeyDown={(e) => e.key === "Enter" && addMemory()}
									/>
									<button className="add-btn" onClick={addMemory}>
										+
									</button>
								</div>
								{memories.length === 0 && (
									<p className="empty-state">No memories stored. JARVIS learns as you chat.</p>
								)}
								{[...memories].reverse().map((m) => (
									<div key={m.id} className="memory-item">
										<span className={`cat-badge cat-${m.category}`}>{m.category}</span>
										<span className="memory-content">{m.content}</span>
										<button className="delete-btn" onClick={() => deleteMemory(m.id)}>
											✕
										</button>
									</div>
								))}
							</div>
						)}

						{/* Tasks */}
						{panel === "tasks" && (
							<div className="panel-content">
								<div className="add-row">
									<select
										value={newTaskPriority}
										onChange={(e) =>
											setNewTaskPriority(e.target.value as Task["priority"])
										}
										className="cat-select"
									>
										<option value="low">low</option>
										<option value="medium">medium</option>
										<option value="high">high</option>
									</select>
									<input
										className="panel-input"
										placeholder="Add task..."
										value={newTask}
										onChange={(e) => setNewTask(e.target.value)}
										onKeyDown={(e) => e.key === "Enter" && addTask()}
									/>
									<input
										type="date"
										className="date-input"
										value={newTaskDue}
										onChange={(e) => setNewTaskDue(e.target.value)}
									/>
									<button className="add-btn" onClick={addTask}>
										+
									</button>
								</div>
								{tasks.length === 0 && (
									<p className="empty-state">No tasks. Tell JARVIS to create some.</p>
								)}
								{pendingTasks.length > 0 && (
									<>
										<div className="task-section-label">ACTIVE</div>
										{pendingTasks.map((t) => (
											<div key={t.id} className={`task-item priority-${t.priority}`}>
												<button
													className="task-check"
													onClick={() => toggleTask(t)}
												>
													○
												</button>
												<div className="task-body">
													<span>{t.content}</span>
													{t.due && (
														<span className="task-due">Due: {t.due}</span>
													)}
												</div>
												<span className={`priority-badge p-${t.priority}`}>
													{t.priority}
												</span>
												<button
													className="delete-btn"
													onClick={() => deleteTask(t.id)}
												>
													✕
												</button>
											</div>
										))}
									</>
								)}
								{doneTasks.length > 0 && (
									<>
										<div className="task-section-label">COMPLETED</div>
										{doneTasks.map((t) => (
											<div key={t.id} className="task-item done">
												<button
													className="task-check checked"
													onClick={() => toggleTask(t)}
												>
													✓
												</button>
												<span className="task-body done-text">{t.content}</span>
												<button
													className="delete-btn"
													onClick={() => deleteTask(t.id)}
												>
													✕
												</button>
											</div>
										))}
									</>
								)}
							</div>
						)}

						{/* Profile */}
						{panel === "profile" && (
							<div className="panel-content">
								<p className="panel-desc">
									JARVIS learns your profile automatically through conversation. You can also set
									values manually here.
								</p>
								<div className="add-row">
									<input
										className="panel-input"
										placeholder="Key (e.g. name)"
										value={profileKey}
										onChange={(e) => setProfileKey(e.target.value)}
									/>
									<input
										className="panel-input"
										placeholder="Value"
										value={profileValue}
										onChange={(e) => setProfileValue(e.target.value)}
										onKeyDown={(e) => e.key === "Enter" && addProfileEntry()}
									/>
									<button className="add-btn" onClick={addProfileEntry}>
										+
									</button>
								</div>
								{Object.keys(profile).length === 0 && (
									<p className="empty-state">No profile data. Start chatting!</p>
								)}
								{Object.entries(profile).map(([k, v]) => (
									<div key={k} className="profile-entry">
										<span className="profile-key">{k}</span>
										<span className="profile-value">{v}</span>
									</div>
								))}
							</div>
						)}
					</aside>
				)}

				{/* ── Chat Area ── */}
				<main className="chat-main">
					<div className="messages-container">
						{messages.length === 0 && (
							<div className="welcome-screen">
								<div className="welcome-arc">
									<div className="welcome-arc-inner" />
								</div>
								<h1 className="welcome-title">Good day.</h1>
								<p className="welcome-sub">
									All systems nominal. How can I assist you?
								</p>
								<div className="welcome-hints">
									{[
										"Search the web for latest AI news",
										"Remember that I prefer dark mode",
										"Create a task: review project proposal",
										"What do you know about me?",
										"Summarize https://news.ycombinator.com",
									].map((hint) => (
										<button
											key={hint}
											className="hint-btn"
											onClick={() => sendMessage(hint)}
										>
											{hint}
										</button>
									))}
								</div>
							</div>
						)}

						{messages.map((msg) => (
							<div key={msg.id} className={`message-row ${msg.role}`}>
								<div className="message-avatar">
									{msg.role === "user" ? "◎" : "⬡"}
								</div>
								<div className="message-bubble">
									{msg.toolsUsed && msg.toolsUsed.length > 0 && (
										<div className="tools-used">
											{msg.toolsUsed.map((t, i) => (
												<span key={i} className="tool-badge">
													⚙ {t}
												</span>
											))}
										</div>
									)}
									<div className="message-content">
										{msg.role === "assistant" ? (
											<ReactMarkdown remarkPlugins={[remarkGfm]}>
												{msg.content}
											</ReactMarkdown>
										) : (
											<p>{msg.content}</p>
										)}
									</div>
								</div>
							</div>
						))}

						{loading && (
							<div className="message-row assistant">
								<div className="message-avatar">⬡</div>
								<div className="message-bubble">
									<div className="thinking">
										<span />
										<span />
										<span />
									</div>
								</div>
							</div>
						)}

						<div ref={bottomRef} />
					</div>

					{/* ── Input Area ── */}
					<div className="input-area">					{listening && (
						<div className="voice-overlay">
							<div className="voice-wave">
								<span/><span/><span/><span/><span/>
							</div>
							<span className="voice-interim">
								{interimTranscript || "Listening…"}
							</span>
							<button className="voice-cancel" onClick={stopListening}>cancel</button>
						</div>
					)}						<div className="input-container">
							<button
								className={`voice-btn ${listening ? "listening" : ""}`}
								onClick={listening ? stopListening : startListening}
								title={listening ? "Stop listening" : "Start voice input"}
							>
								{listening ? "◉" : "◎"}
							</button>

							<textarea
								ref={textareaRef}
								className="chat-input"
								placeholder="Message JARVIS…"
								value={input}
								onChange={(e) => setInput(e.target.value)}
								onKeyDown={handleKeyDown}
								rows={1}
							/>

							{speaking && (
								<button
									className="stop-speak-btn"
									onClick={stopSpeaking}
									title="Stop speaking"
								>
									◼
								</button>
							)}

							<button
								className={`send-btn ${loading ? "disabled" : ""}`}
								onClick={() => sendMessage()}
								disabled={loading}
							>
								{loading ? "…" : "▶"}
							</button>
						</div>
						<p className="input-hint">
							Enter to send · Shift+Enter for newline · Voice input supported
						</p>
					</div>
				</main>
			</div>
		</div>
	);
}
