// Integration test for the `on("context")` image-stripping layer.
//
// Reproduces the bug: an image entered history under ANOTHER provider as a
// toolResult carrying a raw `image` block (e.g. `read` of a PNG under
// kimi-coding). When the user switches to a via-handoff Umans model
// (umans-glm-5.2) and the conversation is replayed, the raw image block must
// NOT reach the gateway. The `context` hook should replace it with an
// `[Image analysis (image:ID)]: ...` text block before the request is sent.
//
// We mock global `fetch` so no network is involved: the /v1/models/info call
// returns a tiny catalog, and /v1/messages (the vision analysis side-call)
// returns a canned analysis. Then we drive the extension with a fake
// ExtensionAPI, emit a synthetic `context` event, and assert the image block
// was replaced.
//
// Run: bun selfcheck-context.ts
import { mock } from "bun:test";

// --- catalog returned by GET /v1/models/info ---
const CATALOG = {
  "umans-glm-5.2": {
    name: "umans-glm-5.2",
    display_name: "Umans GLM 5.2",
    capabilities: {
      context_window: 405504,
      recommended_max_tokens: 131071,
      max_completion_tokens: 131072,
      supports_vision: "via-handoff",
      supports_tools: true,
      reasoning: { supported: true, can_disable: true, levels: ["none", "high", "max"], default_level: "high" },
    },
  },
  "umans-kimi-k2.7": {
    name: "umans-kimi-k2.7",
    display_name: "Umans Kimi K2.7 Code",
    capabilities: {
      context_window: 262144,
      recommended_max_tokens: 32768,
      max_completion_tokens: 262144,
      supports_vision: true,
      supports_tools: true,
      reasoning: { supported: true, can_disable: false, levels: [], default_level: null },
    },
  },
};

const VISION_REPLY = "A screenshot showing the text: hello world";
const IMG_DATA = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB"; // fake base64, content irrelevant

// --- mock global fetch ---
const originalFetch = globalThis.fetch;
let messagesCalls = 0;
globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
  const u = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
  // GET /v1/models/info  (catalog fetch at load)
  if (u.endsWith("/v1/models/info") && (!init || init.method === undefined || init.method === "GET")) {
    return new Response(JSON.stringify(CATALOG), { status: 200, headers: { "content-type": "application/json" } });
  }
  // GET /v1/usage  (status bar poll) — return empty so it no-ops
  if (u.endsWith("/v1/usage")) {
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  }
  // POST /v1/messages  (the vision analysis side-call)
  if (u.endsWith("/v1/messages") && init?.method === "POST") {
    messagesCalls++;
    return new Response(
      JSON.stringify({ content: [{ type: "text", text: VISION_REPLY }] }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }
  return new Response("not found", { status: 404 });
}) as typeof globalThis.fetch;

// --- minimal fake ExtensionAPI that records registrations ---
type Handler = (event: any, ctx: any) => Promise<any>;
type ToolDef = { name: string; execute: (...args: any[]) => Promise<any> };

function createFakePi() {
  const handlers = new Map<string, Handler>();
  const tools = new Map<string, ToolDef>();
  const commands = new Map<string, { handler: (args: string, ctx: any) => any }>();
  const notifications: { level: string; msg: string }[] = [];
  const widgetCalls: { key: string; text?: string }[] = [];
  const statusCalls: { key: string; text?: string }[] = [];

  const ctx = {
    model: { provider: "umans", id: "umans-glm-5.2" } as any,
    ui: {
      notify: (msg: string, level: string) => notifications.push({ level, msg }),
      setWidget: (key: string, text?: any) => widgetCalls.push({ key, text }),
      setStatus: (key: string, text?: string) => statusCalls.push({ key, text }),
      theme: { fg: (_t: string, text: string) => text },
    },
    modelRegistry: { getApiKeyForProvider: async () => "uk-test-key" },
    signal: undefined,
  };

  const pi: any = {
    registerProvider: () => {},
    registerTool: (t: ToolDef) => { tools.set(t.name, t); },
    registerCommand: (name: string, opts: any) => { commands.set(name, opts); },
    on: (event: string, handler: Handler) => { handlers.set(event, handler); },
  };

  return { pi, handlers, tools, commands, notifications, widgetCalls, statusCalls, ctx };
}

function assert(cond: boolean, msg: string) {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exit(1);
  }
  console.log("ok  ", msg);
}

// --- load the extension ---
const mod = await import("./index.ts");
const { pi, handlers, notifications, ctx } = createFakePi();
await (mod as any).default(pi);

assert(handlers.has("context"), "extension registered a `context` handler");
const ctxHandler = handlers.get("context")!;

// --- scenario: history has a toolResult with a raw image block (created under
//     another provider, so message_end never transformed it) + a text user msg ---
const history = [
  {
    role: "toolResult",
    toolCallId: "call_1",
    toolName: "read",
    content: [
      { type: "text", text: "Read image file [image/png]" },
      { type: "image", data: IMG_DATA, mimeType: "image/png" },
    ],
    isError: false,
    timestamp: 1,
  },
  { role: "user", content: [{ type: "text", text: "What does the image say?" }], timestamp: 2 },
] as any[];

const event = { type: "context" as const, messages: history.map((m) => structuredClone(m)) };
const result = await ctxHandler(event, ctx);

// --- assertions ---
assert(result !== undefined, "context handler returned a mutation (images found)");
assert(result.messages !== undefined, "returned { messages }");
assert(messagesCalls === 1, `vision side-call ran exactly once (got ${messagesCalls})`);

const toolResult = result.messages[0];
const blockTypes = toolResult.content.map((b: any) => b.type);
assert(!blockTypes.includes("image"), "raw image block was removed from the toolResult");
assert(blockTypes.includes("text"), "a text block is present in its place");

const analysisBlock = toolResult.content.find((b: any) => typeof b.text === "string" && b.text.startsWith("[Image analysis"));
assert(analysisBlock, "replacement block is an [Image analysis ...] text block");
assert(analysisBlock.text.includes(VISION_REPLY), "analysis block carries the vision model's reply");

// --- replay again: must be free (cached, no new vision side-call) ---
const event2 = { type: "context" as const, messages: history.map((m) => structuredClone(m)) };
const before = messagesCalls;
await ctxHandler(event2, ctx);
assert(messagesCalls === before, `repeat context over same history cost zero vision calls (before=${before}, after=${messagesCalls})`);

// --- native-vision model: context handler must NOT touch images ---
const nativeCtx = { ...ctx, model: { provider: "umans", id: "umans-kimi-k2.7" } };
const event3 = { type: "context" as const, messages: history.map((m) => structuredClone(m)) };
const result3 = await ctxHandler(event3, nativeCtx);
assert(result3 === undefined, "native-vision model: context handler is a no-op (images pass through)");

// --- non-umans provider: no-op ---
const otherCtx = { ...ctx, model: { provider: "kimi-coding", id: "kimi-for-coding" } };
const result4 = await ctxHandler(event3, otherCtx);
assert(result4 === undefined, "non-umans provider: context handler is a no-op");

globalThis.fetch = originalFetch;
console.log("\nall context-hook checks passed");
