# J.A.R.V.I.S

> Just A Rather Very Intelligent System

A persistent, learning AI assistant built on **Cloudflare Workers + Workers AI + KV + React + Hono + Vite**. Not a toy — a real tool that remembers, learns, manages tasks, searches the web, and grows more useful with every conversation.

---

## Features

| Capability | How it works |
|---|---|
| **Persistent memory** | JARVIS saves facts about you across sessions via Cloudflare KV |
| **User profile** | Key/value store JARVIS learns and updates automatically |
| **Task management** | Full task CRUD with priorities, due dates, and completion |
| **Conversation history** | Full history per conversation, up to 100 conversations stored |
| **Web search** | Live Brave Search results (requires `BRAVE_API_KEY` secret) |
| **URL fetching** | JARVIS can read any URL you provide |
| **Agentic tool loop** | Up to 3 rounds of tool use per response |
| **Voice I/O** | Web Speech API for mic input and TTS output |
| **GPT-4o support** | Set `OPENAI_API_KEY` to upgrade from Workers AI |
| **HUD interface** | Iron Man–style dark UI with cyan glows |

---

## Quick Start

```bash
npm install
npm run dev
```

---

## Setup: KV Namespace

You need a real KV namespace for production:

```bash
# Create the namespace
npx wrangler kv namespace create MEMORY

# Copy the returned ID into wrangler.json → kv_namespaces[0].id
```

---

## Setup: Secrets

### Brave Search (for live web search)
Get a free API key at https://brave.com/search/api/

```bash
npx wrangler secret put BRAVE_API_KEY
```

### OpenAI GPT-4o (optional upgrade)
```bash
npx wrangler secret put OPENAI_API_KEY
```

Without these, JARVIS uses Cloudflare Workers AI (llama-3.3-70b) and responds from training knowledge.

---

## Deploy

```bash
npm run deploy
```

---

## How JARVIS Learns

JARVIS's system prompt is dynamically built every request from:
1. Your stored memories (last 30)
2. Your user profile (name, timezone, occupation, etc.)
3. Your pending tasks

JARVIS silently calls `save_memory` or `update_profile` tools mid-conversation. Manage them manually via the side panels.

---

## API Reference

| Endpoint | Method | Description |
|---|---|---|
| `/api/chat` | POST | Send a message |
| `/api/memories` | GET/POST | List/add memories |
| `/api/memories/:id` | DELETE | Delete a memory |
| `/api/tasks` | GET/POST | List/create tasks |
| `/api/tasks/:id` | PATCH/DELETE | Update/delete task |
| `/api/conversations` | GET | List conversations |
| `/api/conversations/:id` | GET/DELETE | Load/delete conversation |
| `/api/profile` | GET/PATCH | Read/update user profile |
| `/api/status` | GET | System status |
