import { Service } from "@deepseek-ai/cordis";
import { AgentModel, agentEvents, modelSelectionProjectionDefinition } from "@deepseek-ai/dsh-agent";
import AgentLoop from "@deepseek-ai/dsh-agent-loop";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { LlmAdapter, LlmAttemptId, LlmError, ToolCallId, createAssistantMessage, createToolResultMessage } from "@deepseek-ai/dsh-llm";
import { createScope } from "@deepseek-ai/dsh-scope";
import { SessionSeq } from "@deepseek-ai/dsh-session";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
//#region lib/types/bindings.js
/**
* Read the session map. A missing file is an empty map. Malformed JSON throws.
* @param stateDir - directory that holds `bindings.json`.
* @returns remembered CLI sessions.
*/
async function readBindings(stateDir) {
	if (stateDir === "") return /* @__PURE__ */ new Map();
	try {
		const text = await readFile(join(stateDir, "bindings.json"), "utf8");
		const parsed = JSON.parse(text);
		return new Map(Object.entries(parsed.sessions ?? {}));
	} catch (error) {
		if (isNotFound(error)) return /* @__PURE__ */ new Map();
		throw error;
	}
}
/**
* Replace the session map. The write is a temp file plus rename.
* @param stateDir - directory that holds `bindings.json`. Empty skips the write.
* @param sessions - complete map to store.
*/
async function writeBindings(stateDir, sessions) {
	if (stateDir === "") return;
	await mkdir(stateDir, { recursive: true });
	const body = { sessions: Object.fromEntries(sessions) };
	const path = join(stateDir, "bindings.json");
	const temporary = `${path}.${process.pid}.tmp`;
	await writeFile(temporary, `${JSON.stringify(body)}\n`, "utf8");
	await rename(temporary, path);
}
function isNotFound(error) {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
//#endregion
//#region lib/types/constants.js
/** Provider id that selects the CodeBuddy driver at session create or resume. */
const CODEBUDDY_PROVIDER = "codebuddy";
/** Preset id for 创造模式. Only this preset attaches the DSH tool bridge. */
const CREATOR_PRESET = "cordis";
/** Tool the creator-mode bridge exposes. Native CLI tools are not in this list. */
const BRIDGE_TOOL = "plugin_manager";
/**
* Synthetic model id meaning "let the CLI pick".
*
* The provider advertises it first so a fresh session has an explicit choice
* that round-trips to "pass no `--model`". The CLI then resolves the model from
* its own settings, which is why selecting it must never send a real id.
*
* No CodeBuddy build lists this id, and discovery drops it if one ever does, so
* a picker cannot end up with two entries carrying the same id.
*/
const DEFAULT_MODEL_ID = "default";
//#endregion
//#region lib/types/models.js
/** Sentence the CLI uses to introduce the model ids it accepts. */
const SUPPORTED_PREFIX = "Currently supported:";
/** Model ids seen before the `--model` description added the supported list. */
const BUILTIN_MODELS = [
	"claude-sonnet-5",
	"claude-sonnet-5-1m",
	"claude-sonnet-4.6",
	"claude-opus-5.5",
	"claude-sonnet-5.5",
	"claude-haiku-5.5",
	"claude-opus-5",
	"claude-opus-4.8-1m",
	"claude-opus-4.7-1m",
	"claude-opus-4.6-1m",
	"gemini-3.1-pro",
	"gemini-3.5-flash",
	"gpt-6-astra",
	"gpt-6.1-sol",
	"gpt-6-sol",
	"gpt-6-luna",
	"gpt-5.6-sol",
	"gpt-5.6-terra",
	"gpt-5.6-luna",
	"glm-5.3-ioa",
	"glm-5.3-flash-ioa",
	"glm-5.3-flashx",
	"glm-5.2-ioa",
	"glm-5.2-internal-ioa",
	"minimax-m3.1-flash",
	"minimax-m3-ioa",
	"minimax-m2.7-ioa",
	"kimi-k3.1-pro",
	"kimi-k3-ioa",
	"kimi-k2.8-preview",
	"hy4std",
	"hy3-ioa",
	"echo",
	"deepseek-v4.1-flash",
	"deepseek-v4-pro-ioa",
	"mimo-v2.6-pro"
];
/**
* Pull the supported model ids out of CLI help text.
*
* The synthetic default id is dropped: the catalog owns that row, and a CLI
* that ever listed it would otherwise produce a duplicate picker entry.
* @param help - combined stdout and stderr of `<cli> --help`.
* @returns ids in the order the CLI printed them, without duplicates.
*/
function parseSupportedModels(help) {
	const at = help.indexOf(SUPPORTED_PREFIX);
	if (at < 0) return [];
	const open = help.indexOf("(", at + 20);
	if (open < 0) return [];
	const close = help.indexOf(")", open + 1);
	if (close < 0) return [];
	const ids = help.slice(open + 1, close).split(",").map((entry) => entry.trim()).filter((entry) => entry !== "" && entry !== "default");
	return [...new Set(ids)];
}
/**
* Read the model named by the CLI's own settings file.
*
* This is the model a session uses when the harness passes no `--model`, so
* the picker can show that value as the active default instead of inventing
* a name the CLI would reject.
* @param settingsPath - absolute path to the CLI's `settings.json`.
* @returns the configured model id, or `''` when the file is absent or unreadable.
*/
async function readConfiguredModel(settingsPath) {
	try {
		const parsed = JSON.parse(await readFile(settingsPath, "utf8"));
		if (parsed === null || typeof parsed !== "object") return "";
		const model = parsed.model;
		return typeof model === "string" ? model : "";
	} catch {
		return "";
	}
}
const cache = /* @__PURE__ */ new Map();
/**
* Run `<cli> --help` once and read the CLI's configured model.
* @param ctx - context whose subprocess service owns the child process.
* @param input - absolute CLI path, settings path, and timeout.
* @returns discovered ids and the configured default, both may be empty.
*/
async function discoverModels(ctx, input) {
	const key = `${input.command}\u0000${input.args.join("\0")}\u0000${input.settingsPath}`;
	const cached = cache.get(key);
	if (cached !== void 0) return cached;
	const configured = await readConfiguredModel(input.settingsPath);
	const models = await readHelpModels(ctx, input.command, input.args, input.timeoutMs);
	const result = {
		models: models.length > 0 ? models : BUILTIN_MODELS,
		configured
	};
	cache.set(key, result);
	return result;
}
/** Spawn `<cli> --help` and parse its supported-model sentence. */
async function readHelpModels(ctx, command, args, timeoutMs) {
	let handle;
	try {
		handle = ctx.subprocess.spawn({
			argv: [
				command,
				...args,
				"--help"
			],
			cwd: process.cwd(),
			stdio: {
				stdin: "ignore",
				stdout: { maxBytes: 1 << 20 },
				stderr: { maxBytes: 1 << 20 }
			},
			graceMs: 1e3
		});
	} catch {
		return [];
	}
	const timer = setTimeout(() => {
		handle?.terminate();
	}, timeoutMs);
	try {
		await handle.done;
	} catch {
		return [];
	} finally {
		clearTimeout(timer);
	}
	const collected = handle.collected;
	return parseSupportedModels(`${collected.stdout?.readFrom(0).text ?? ""}\n${collected.stderr?.readFrom(0).text ?? ""}`);
}
//#endregion
//#region lib/types/catalog.js
/**
* Publish `codebuddy` on the existing provider catalog.
* Session creation still chooses the CLI driver. This adapter does not run a model call.
* @param ctx - context whose LLM registry the model picker reads.
* @param settings - deployment settings carrying the CLI path and optional override.
* @returns the disposer that removes the route.
*/
function registerCodeBuddyCatalog(ctx, settings) {
	const adapter = new CodeBuddyCatalog(ctx, settings);
	const registered = ctx.llm.registerAdapter([CODEBUDDY_PROVIDER], adapter);
	const directory = ctx.llm.registerConfigurableProviders([{
		provider: CODEBUDDY_PROVIDER,
		displayName: "CodeBuddy",
		settingsNs: "agent-codebuddy-settings",
		settingsPath: []
	}]);
	return () => {
		directory();
		registered();
	};
}
/**
* Catalog row for the CLI driver. `stream` fails closed so a DeepSeek loop
* cannot impersonate the CLI.
*
* The advertised set is the synthetic {@link DEFAULT_MODEL_ID} entry followed by
* what the CLI accepts: an explicit `models` list from settings when present,
* otherwise the ids the CLI prints in its own `--model` help.
*
* The default entry comes first because a picker that has no saved selection
* shows the first row, and a session that passes no `--model` is exactly what
* selecting it means. Its description names the model the CLI will actually
* run, read from the CLI's own settings file.
*/
var CodeBuddyCatalog = class extends LlmAdapter {
	ctx;
	settings;
	constructor(ctx, settings) {
		super();
		this.ctx = ctx;
		this.settings = settings;
	}
	providerInfo(provider) {
		return {
			id: provider,
			name: "CodeBuddy"
		};
	}
	/**
	* Resolve one exact model id for the call pipeline.
	*
	* The base implementation echoes the id, which would label a picker entry
	* `default` and leave the session-controller with nothing to validate against.
	* Answering from the same catalog `listModels` advertises keeps selection and
	* display consistent, and a request for an id the catalog does not offer fails
	* here instead of inside the CLI.
	* @param provider - the route this adapter registered.
	* @param model - exact model id a user selected.
	* @returns resolved identity plus the modalities the catalog declared.
	*/
	async resolveModel(provider, model) {
		const catalog = await this.catalog();
		if (model === "default") {
			const configured = catalog.configured;
			return {
				provider,
				id: model,
				name: "Default",
				description: configured === "" ? "Uses the model configured in the CodeBuddy CLI" : `Uses the CodeBuddy CLI's configured model: ${configured}`,
				inputModalities: ["text"]
			};
		}
		if (!catalog.models.includes(model)) throw new LlmError(`CodeBuddy does not advertise model "${model}"`, "UNKNOWN_MODEL");
		return {
			provider,
			id: model,
			name: model,
			inputModalities: ["text"]
		};
	}
	async listModels(provider) {
		const catalog = await this.catalog();
		const real = catalog.models.filter((id) => id !== DEFAULT_MODEL_ID);
		const configured = catalog.configured;
		return [{
			provider,
			id: DEFAULT_MODEL_ID,
			name: "Default",
			description: configured === "" ? "Uses the model configured in the CodeBuddy CLI" : `Uses the CodeBuddy CLI's configured model: ${configured}`,
			inputModalities: ["text"],
			badge: {
				text: {
					en: "CLI default",
					zh: "CLI 默认"
				},
				tone: "info"
			}
		}, ...real.map((id) => ({
			provider,
			id,
			name: id,
			...id === configured ? { description: "Currently the configured default in the CodeBuddy CLI" } : {},
			inputModalities: ["text"]
		}))];
	}
	async *stream() {
		throw new LlmError("provider \"codebuddy\" is served by the CLI session driver; this adapter only advertises the route", "CODEBUDDY_DRIVER");
	}
	/** Resolved catalog, honoring an explicit settings list over discovery. */
	async catalog() {
		const configured = this.settings.config.models;
		if (configured.length > 0) {
			const fallback = this.settings.config.model;
			return {
				models: configured,
				configured: fallback === "" ? configured[0] ?? "" : fallback
			};
		}
		return discoverModels(this.ctx, {
			command: this.settings.config.command,
			args: this.settings.config.args,
			settingsPath: this.settings.config.cliSettingsPath,
			timeoutMs: this.settings.config.modelsTimeoutMs
		});
	}
};
//#endregion
//#region lib/types/bridge.js
/**
* Answer one creator-mode MCP request. `tools/call` runs the registered
* `plugin_manager` tool once. Native CLI tools never reach this function.
* @param ctx - host context that owns the tool registry.
* @param agent - session agent, required by the tool's own approval path.
* @param signal - cancellation for the tool body.
* @param call - JSON-RPC request from the CLI.
* @returns the JSON-RPC result and whether the tool body ran.
*/
async function handleBridgeCall(ctx, agent, signal, call) {
	if (call.method === "tools/list" || call.method === "initialize") {
		const tool = ctx.tools.executable(BRIDGE_TOOL, agent);
		return {
			executed: false,
			body: call.method === "initialize" ? {
				protocolVersion: "2024-11-05",
				capabilities: { tools: {} },
				serverInfo: {
					name: "dsh",
					version: "0"
				}
			} : { tools: tool === void 0 ? [] : [{
				name: BRIDGE_TOOL,
				description: tool.description,
				inputSchema: { type: "object" }
			}] }
		};
	}
	if (call.method !== "tools/call") return {
		executed: false,
		body: { error: {
			code: -32601,
			message: `unsupported mcp method "${call.method}"`
		} }
	};
	const params = call.params !== null && typeof call.params === "object" ? call.params : {};
	const name = typeof params.name === "string" ? params.name : "";
	if (name !== "plugin_manager") return {
		executed: false,
		body: { error: {
			code: -32602,
			message: `tool "${name}" is not bridged`
		} }
	};
	const tool = ctx.tools.executable(BRIDGE_TOOL, agent);
	if (tool === void 0) return {
		executed: false,
		body: {
			content: [{
				type: "text",
				text: "plugin_manager is not registered in this session"
			}],
			isError: true
		}
	};
	const exec = {
		name: BRIDGE_TOOL,
		arguments: params.arguments,
		signal,
		agent
	};
	const value = await tool.execute(params.arguments, exec);
	return {
		executed: true,
		body: {
			content: [{
				type: "text",
				text: typeof value === "string" ? value : JSON.stringify(value)
			}],
			isError: false
		}
	};
}
//#endregion
//#region lib/types/protocol.js
const IGNORED = new Set([
	"tool_progress",
	"topic",
	"ai-title",
	"file-history-snapshot"
]);
/**
* CLI arguments for one query. No system prompt and no DSH tool whitelist.
*
* `--permission-mode` is always `bypassPermissions`: the driver never answers a
* permission question, so the CLI must not ask one. A mode that asks would leave
* every gated tool denied, which reads to a user as a silently dropped turn.
* `--setting-sources` is omitted so the installed CLI keeps its own login and settings.
* @param input - resume id, optional explicit model, and partial-message flag.
* @returns argv after the executable.
*/
function launchArgs(input) {
	const args = [
		"--input-format=stream-json",
		"--output-format=stream-json",
		"--verbose",
		"--permission-mode",
		"bypassPermissions"
	];
	if (input.partial) args.push("--include-partial-messages");
	if (input.model !== void 0 && input.model !== "") args.push("--model", input.model);
	if (input.resume !== void 0 && input.resume !== "") args.push("--resume", input.resume);
	return args;
}
/**
* Control initialize body. Creator mode names the in-process bridge server.
* The body has no system prompt.
* @param creator - whether this session selected the cordis preset.
* @returns the `initialize` request payload.
*/
function initializeRequest(creator) {
	return {
		subtype: "initialize",
		hooks: {},
		hasPrompt: true,
		capabilities: { askUserQuestion: true },
		...creator ? { sdkMcpServers: ["dsh"] } : {}
	};
}
/** Fold one CLI message. Unknown types become a fault and are not treated as success. */
var Projector = class {
	sawResult = false;
	openTools = /* @__PURE__ */ new Set();
	/** Live deltas already represented by a committed assistant message. */
	liveText = "";
	/**
	* Project one message.
	* @param message - parsed NDJSON object.
	* @returns zero or more projections, or a fault that fails the turn.
	*/
	push(message) {
		const type = typeof message.type === "string" ? message.type : "";
		if (type === "") return {
			events: [],
			fault: {
				code: "UNKNOWN_PROTOCOL",
				detail: "event has no type"
			}
		};
		if (type === "result") {
			if (this.sawResult) return {
				events: [],
				fault: {
					code: "DUPLICATE_RESULT",
					detail: "a second result arrived"
				}
			};
			return { events: this.result(message) };
		}
		if (this.sawResult) return {
			events: [],
			fault: {
				code: "LATE_EVENT",
				detail: `event type "${type}" arrived after result`
			}
		};
		switch (type) {
			case "system": return { events: this.system(message) };
			case "stream_event": return { events: this.stream(message) };
			case "assistant": return { events: this.assistant(message) };
			case "user": return { events: this.user(message) };
			case "error": return {
				events: [],
				fault: {
					code: "CLI_ERROR",
					detail: textField(message, "error") || "cli error"
				}
			};
			default:
				if (IGNORED.has(type) || type === "system") return { events: [diagnostic("IGNORED_EVENT", type)] };
				return {
					events: [],
					fault: {
						code: "UNKNOWN_PROTOCOL",
						detail: `unrecognized event type "${type}"`
					}
				};
		}
	}
	system(message) {
		const subtype = typeof message.subtype === "string" ? message.subtype : "";
		if (subtype === "init") {
			const id = typeof message.session_id === "string" ? message.session_id : "";
			return id === "" ? [diagnostic("MISSING_SESSION", "init event has no session_id")] : [{
				kind: "session",
				cliSessionId: id
			}];
		}
		if (subtype === "task_started" || subtype === "task_progress" || subtype === "task_updated" || subtype === "task_notification" || subtype === "status" || subtype === "compact_boundary") return [diagnostic("IGNORED_EVENT", `system/${subtype}`)];
		return [diagnostic("IGNORED_EVENT", subtype === "" ? "system" : `system/${subtype}`)];
	}
	stream(message) {
		const event = record(message.event);
		const delta = event === void 0 ? void 0 : record(event.delta);
		const text = delta?.type === "text_delta" && typeof delta.text === "string" ? delta.text : void 0;
		if (text === void 0) return [diagnostic("IGNORED_EVENT", "stream_event")];
		this.liveText += text;
		return [{
			kind: "live-text",
			text
		}];
	}
	assistant(message) {
		const body = record(message.message);
		const content = body?.content;
		const blocks = [];
		const events = [];
		if (typeof content === "string") blocks.push({
			type: "text",
			text: content
		});
		else if (Array.isArray(content)) for (const block of content) {
			const item = record(block);
			if (item === void 0) {
				events.push(diagnostic("UNKNOWN_BLOCK", "assistant content block is not an object"));
				continue;
			}
			if (item.type === "text" && typeof item.text === "string") blocks.push({
				type: "text",
				text: item.text
			});
			else if (item.type === "thinking" && typeof item.thinking === "string") blocks.push({
				type: "reasoning",
				text: item.thinking
			});
			else if (item.type === "redacted_thinking") events.push(diagnostic("REDACTED_THINKING", "redacted thinking was not copied"));
			else if (item.type === "tool_use") {
				if (blocks.length > 0) {
					events.push({
						kind: "assistant",
						blocks: [...blocks]
					});
					blocks.length = 0;
					this.liveText = "";
				}
				events.push(...this.toolUse(item));
			} else if (item.type === "image") events.push(diagnostic("IMAGE_OMITTED", "assistant image bytes were not copied"));
			else events.push(diagnostic("UNKNOWN_BLOCK", `assistant block "${String(item.type)}"`));
		}
		if (blocks.length > 0) {
			events.push({
				kind: "assistant",
				blocks
			});
			this.liveText = "";
		}
		const usage = usageOf(body?.usage);
		if (usage !== void 0) events.push({
			kind: "usage",
			...usage
		});
		return events;
	}
	toolUse(item) {
		const id = typeof item.id === "string" ? item.id : "";
		const name = typeof item.name === "string" ? item.name : "";
		if (id === "" || name === "") return [diagnostic("MALFORMED_TOOL", "tool_use is missing id or name")];
		this.openTools.add(id);
		let args = "";
		try {
			args = JSON.stringify(item.input ?? {});
		} catch {
			return [diagnostic("MALFORMED_TOOL", `tool_use "${id}" input is not JSON`)];
		}
		return [{
			kind: "tool-call",
			id,
			name,
			arguments: args
		}];
	}
	user(message) {
		const content = record(message.message)?.content;
		if (typeof content === "string") return [{
			kind: "assistant",
			blocks: [{
				type: "text",
				text: content
			}]
		}];
		if (!Array.isArray(content)) return [diagnostic("IGNORED_EVENT", "user")];
		const events = [];
		for (const block of content) {
			const item = record(block);
			if (item?.type !== "tool_result") {
				events.push(diagnostic("UNKNOWN_BLOCK", "user content is not a tool_result"));
				continue;
			}
			const id = typeof item.tool_use_id === "string" ? item.tool_use_id : "";
			if (id === "" || !this.openTools.has(id)) events.push(diagnostic("UNPAIRED_TOOL_RESULT", id === "" ? "missing tool_use_id" : id));
			this.openTools.delete(id);
			events.push({
				kind: "tool-result",
				id,
				text: toolResultText(item.content),
				isError: item.is_error === true
			});
		}
		return events;
	}
	result(message) {
		if (this.sawResult) return [];
		this.sawResult = true;
		const events = [];
		if (this.liveText !== "") {
			events.push({
				kind: "assistant",
				blocks: [{
					type: "text",
					text: this.liveText
				}]
			});
			this.liveText = "";
		}
		const subtype = typeof message.subtype === "string" ? message.subtype : "";
		const text = typeof message.result === "string" ? message.result : "";
		const isError = message.is_error === true || subtype !== "success";
		events.push({
			kind: "result",
			text,
			isError
		});
		if (this.openTools.size > 0) events.push(diagnostic("UNCLOSED_TOOL", [...this.openTools].join(",")));
		return events;
	}
};
/**
* True when this projection is a duplicate of the result text already committed.
* @param events - projections from one result message.
* @param committed - assistant texts already committed in this turn.
* @returns events with a trailing assistant copy of the result removed.
*/
function withoutDuplicateResultText(events, committed) {
	const result = events.find((event) => event.kind === "result");
	if (result === void 0 || result.kind !== "result" || result.text === "") return events;
	if (!committed.includes(result.text)) return events;
	return events.filter((event) => event.kind !== "assistant");
}
function diagnostic(code, detail) {
	return {
		kind: "diagnostic",
		code,
		detail
	};
}
function record(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? value : void 0;
}
function textField(message, key) {
	const value = message[key];
	return typeof value === "string" ? value : "";
}
function toolResultText(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((block) => {
		const item = record(block);
		return item?.type === "text" && typeof item.text === "string" ? item.text : "";
	}).join("");
}
function usageOf(value) {
	const usage = record(value);
	if (usage === void 0) return void 0;
	const input = numberField(usage, "input_tokens");
	const output = numberField(usage, "output_tokens");
	if (input === void 0 || output === void 0) return void 0;
	return {
		inputTokens: input,
		outputTokens: output
	};
}
function numberField(message, key) {
	const value = message[key];
	return typeof value === "number" && Number.isFinite(value) ? value : void 0;
}
//#endregion
//#region lib/types/transport.js
/**
* Spawn the configured CLI and speak stream-json. Interrupt acknowledgement
* does not count as exit; `cancel` always terminates the managed process range.
* @param ctx - context whose subprocess service owns the process group.
* @param input - executable, arguments, directory, and creator-mode flag.
* @returns the live query.
*/
async function startQuery(ctx, input) {
	const handle = ctx.subprocess.spawn({
		argv: [
			input.command,
			...input.args,
			...launchArgs({
				...input.resume !== void 0 && input.resume !== "" ? { resume: input.resume } : {},
				...input.model !== void 0 && input.model !== "" ? { model: input.model } : {},
				partial: true
			})
		],
		cwd: input.cwd,
		stdio: {
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe"
		},
		graceMs: input.graceMs
	});
	const sent = [];
	handle.stdin?.on("error", () => {});
	const write = (value) => {
		sent.push(value);
		handle.stdin?.write(`${JSON.stringify(value)}\n`);
	};
	let stderr = "";
	handle.stderr?.on("data", (chunk) => {
		stderr = `${stderr}${chunk.toString()}`.slice(-4e3);
	});
	const messages = readMessages(handle);
	write({
		type: "control_request",
		request_id: "init",
		request: initializeRequest(input.creator)
	});
	write({
		type: "user",
		session_id: "",
		message: {
			role: "user",
			content: input.prompt
		},
		parent_tool_use_id: null
	});
	return {
		messages,
		sent,
		send: write,
		terminate: () => {
			try {
				write({
					type: "control_request",
					request_id: "interrupt",
					request: {
						subtype: "interrupt",
						reason: "User interrupt"
					}
				});
			} catch {}
			handle.terminate();
		},
		finished: async () => {
			return {
				exitCode: (await handle.done.catch(() => ({
					exitCode: null,
					signal: "SIGKILL"
				}))).exitCode,
				stderr: redact(stderr)
			};
		}
	};
}
async function* readMessages(handle) {
	if (handle.stdout === void 0) return;
	const lines = createInterface({
		input: handle.stdout,
		crlfDelay: Infinity
	});
	for await (const line of lines) {
		const trimmed = line.trim();
		if (trimmed === "") continue;
		try {
			yield JSON.parse(trimmed);
		} catch {
			yield {
				type: "error",
				error: "stdout line is not JSON"
			};
		}
	}
}
/**
* Drop obvious credential material from a diagnostic tail.
* @param text - stderr or protocol detail that may contain a token.
* @returns the same text with bearer tokens, `sk-` keys, and secret assignments replaced.
*/
function redact(text) {
	return text.replace(/Bearer\s+\S+/gi, "Bearer [redacted]").replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[redacted]").replace(/(api[_-]?key|token|secret)(["']?\s*[:=]\s*["']?)[^"',\s}]+/gi, "$1$2[redacted]");
}
//#endregion
//#region lib/types/driver.js
/**
* Text sent to the CLI. Non-text blocks refuse the turn before any process starts.
* @param message - the user message taken from the inbox.
* @returns the joined text blocks.
*/
function promptText(message) {
	const blocks = message.content;
	const foreign = blocks.filter((block) => block.type !== "text").map((block) => block.type);
	if (foreign.length > 0) throw new Error(`UNSUPPORTED_INPUT: CodeBuddy prompt keeps text only; refused block types ${foreign.join(",")}`);
	return blocks.map((block) => block.type === "text" ? block.text : "").join("\n");
}
/**
* Run one CLI turn and append the projected events.
* @param input - the host, session, prompt, and CLI launch for this turn.
* @returns nothing. The CLI session id is stored through `input.onSession`.
*/
async function runCliTurn(input) {
	const session = input.session;
	session.append("turn/start", { turn: input.turn });
	session.append("user/message", input.message, { surfaceOp: "append" });
	const query = await startQuery(input.ctx, {
		command: input.command,
		args: input.args,
		cwd: input.cwd,
		...input.resume !== void 0 && input.resume !== "" ? { resume: input.resume } : {},
		...input.model !== void 0 && input.model !== "" ? { model: input.model } : {},
		creator: input.creator,
		prompt: input.prompt,
		graceMs: input.graceMs
	});
	const abortQuery = () => {
		query.terminate();
	};
	input.signal.addEventListener("abort", abortQuery, { once: true });
	if (input.signal.aborted) abortQuery();
	const projector = new Projector();
	const committed = [];
	let usage;
	let fault;
	let sawResult = false;
	let resultError = false;
	let step = 1;
	const attempt = LlmAttemptId(`codebuddy-${input.turn}`);
	let revision = 1;
	let chunkIndex = 0;
	const dispatch = agentEvents(input.ctx, input.agent);
	let started = false;
	/**
	* Step boundary bookkeeping.
	*
	* The Chat client keeps an assistant message's transient stream rows until
	* the Step that owns it ends, so it can retire them and reveal the durable
	* message in their place. A driver that never records `step/end` leaves both
	* visible at once, which reads as the same reply printed twice until the turn
	* closes. The stock `agent-loop` brackets every step with `step/start` and
	* `step/end`; this driver has to do the same.
	*/
	let openStep;
	const stepStart = (value) => {
		if (openStep === value) return;
		if (openStep !== void 0) session.append("step/end", {
			turn: input.turn,
			step: openStep
		});
		session.append("step/start", {
			turn: input.turn,
			step: value
		});
		openStep = value;
	};
	const stepEnd = (value) => {
		const closing = value ?? openStep;
		if (closing === void 0) return;
		session.append("step/end", {
			turn: input.turn,
			step: closing
		});
		if (openStep === closing) openStep = void 0;
	};
	const finishLive = (seq) => {
		if (!started) return;
		dispatch.emit("agent/assistant-stream", { frame: {
			type: "end",
			attemptId: attempt,
			revision,
			index: chunkIndex,
			outcome: seq === void 0 ? { kind: "abandoned" } : {
				kind: "committed",
				eventType: "assistant/message",
				seq: SessionSeq(seq)
			}
		} });
		started = false;
		revision += 1;
		chunkIndex = 0;
	};
	const closed = new AbortController();
	const stopReading = () => {
		closed.abort();
	};
	try {
		if (input.signal.aborted) throw abortError();
		input.signal.addEventListener("abort", stopReading, { once: true });
		const lines = query.messages[Symbol.asyncIterator]();
		for (;;) {
			const next = await raceAbort(lines.next(), closed.signal);
			if (next === void 0 || next.done === true || input.signal.aborted) {
				lines.return?.(void 0);
				break;
			}
			const message = next.value;
			if (message.type === "control_request") {
				await answerControl(input, query, message, input.turn, step);
				continue;
			}
			if (message.type === "control_response") continue;
			const projected = projector.push(message);
			if (projected.fault !== void 0) fault = projected.fault;
			const events = withoutDuplicateResultText(projected.events, committed);
			for (const event of events) if (event.kind === "session") await input.onSession(event.cliSessionId);
			else if (event.kind === "live-text") {
				if (!started) {
					dispatch.emit("agent/assistant-stream", { frame: {
						type: "start",
						attemptId: attempt,
						revision,
						turn: input.turn,
						step
					} });
					started = true;
				}
				dispatch.emit("agent/assistant-stream", { frame: {
					type: "chunk",
					attemptId: attempt,
					revision,
					index: chunkIndex,
					time: Date.now(),
					chunk: {
						type: "text-delta",
						index: 0,
						text: event.text
					}
				} });
				chunkIndex += 1;
			} else if (event.kind === "usage") usage = {
				inputTokens: event.inputTokens,
				outputTokens: event.outputTokens
			};
			else if (event.kind === "assistant") {
				const text = event.blocks.filter((block) => block.type === "text").map((block) => block.text).join("");
				if (text !== "") committed.push(text);
				stepStart(step);
				finishLive(appendAssistant(session, input.turn, step, event.blocks, usage, input.recordModel));
				stepEnd(step);
				step += 1;
			} else if (event.kind === "tool-call") {
				stepStart(step);
				session.append("tool/call", {
					turn: input.turn,
					step,
					callId: ToolCallId(event.id),
					name: event.name,
					arguments: event.arguments
				});
			} else if (event.kind === "tool-result") {
				stepStart(step);
				const call = findCall(session, event.id) ?? previousSeq(session);
				session.append("tool/result", {
					turn: input.turn,
					step,
					message: createToolResultMessage({
						callId: ToolCallId(event.id),
						content: [{
							type: "text",
							text: event.text
						}],
						isError: event.isError
					})
				}, {
					surfaceOp: "append",
					sourceEventSeqs: [call]
				});
			} else if (event.kind === "result") {
				sawResult = true;
				resultError = event.isError;
			} else if (event.kind === "diagnostic") input.ctx.logger.warn(`codebuddy ${event.code}: ${event.detail}`);
			if (fault !== void 0 || events.some((event) => event.kind === "result")) break;
		}
	} finally {
		input.signal.removeEventListener("abort", stopReading);
		input.signal.removeEventListener("abort", abortQuery);
		finishLive(void 0);
		stepEnd();
		if (input.signal.aborted) {
			query.terminate();
			session.append("turn/end", {
				turn: input.turn,
				reason: {
					kind: "aborted",
					reason: abortedCause(input.signal)
				}
			});
		} else if (sawResult) {
			if (resultError) session.append("turn/end", {
				turn: input.turn,
				reason: {
					kind: "error",
					error: {
						message: "cli result reported an error",
						code: "CLI_RESULT"
					}
				}
			});
			else session.append("turn/end", {
				turn: input.turn,
				reason: { kind: "completed" }
			});
			query.terminate();
		} else {
			const done = await query.finished();
			if (fault !== void 0 || done.exitCode !== 0 && done.exitCode !== null) {
				const detail = fault?.detail ?? `cli exited ${done.exitCode}`;
				const stderr = done.stderr === "" ? "" : `; stderr: ${done.stderr}`;
				session.append("turn/end", {
					turn: input.turn,
					reason: {
						kind: "error",
						error: {
							message: `${fault?.code ?? "CLI_EXIT"}: ${detail}${stderr}`,
							code: fault?.code ?? "CLI_EXIT"
						}
					}
				});
			} else session.append("turn/end", {
				turn: input.turn,
				reason: { kind: "completed" }
			});
		}
		await input.dispatch.serial("agent/turn-stopping", {
			turn: input.turn,
			signal: input.signal
		});
	}
}
function previousSeq(session) {
	return session.snapshotEvents().at(-1)?.seq ?? SessionSeq(0);
}
/**
* Await one async-iterator step, or give up as soon as `signal` aborts.
* @param step - the pending read from a CLI stream.
* @param signal - aborts when the turn is cancelled.
* @returns the step result, or `undefined` once the signal aborted first.
*/
async function raceAbort(step, signal) {
	if (signal.aborted) return void 0;
	const aborted = Promise.withResolvers();
	const onAbort = () => {
		aborted.resolve(void 0);
	};
	signal.addEventListener("abort", onAbort, { once: true });
	try {
		return await Promise.race([step, aborted.promise]);
	} finally {
		signal.removeEventListener("abort", onAbort);
	}
}
/**
* Copy only the fields `turn/end` records from the cancel cause carried by an
* Agent-owned signal. The live reason may carry a `stack` that the log cannot.
* @param signal - the turn signal aborted by {@link Agent.cancel}.
* @returns the durable cancel cause, defaulting to a user stop.
*/
function abortedCause(signal) {
	const cause = signal.reason;
	switch (cause?.kind) {
		case "user":
		case "parent":
		case "disposed": return { kind: cause.kind };
		case "hook": return {
			kind: "hook",
			reason: cause.reason
		};
		default: return { kind: "user" };
	}
}
function appendAssistant(session, turn, step, blocks, usage, model) {
	const content = blocks.map((block) => block.type === "text" ? {
		type: "text",
		text: block.text
	} : {
		type: "reasoning",
		text: block.text
	});
	const text = blocks.filter((block) => block.type === "text").map((block) => block.text);
	return session.append("assistant/message", {
		turn,
		step,
		message: createAssistantMessage({
			content,
			source: {
				provider: CODEBUDDY_PROVIDER,
				model
			}
		}),
		stream: text.length === 0 ? [] : [{
			type: "text-chunks",
			time0: Date.now(),
			index: 0,
			dt: text.map(() => 0),
			texts: text
		}],
		...usage === void 0 ? {} : { usage }
	}, { surfaceOp: "append" }).seq;
}
function findCall(session, id) {
	const events = session.snapshotEvents();
	for (let index = events.length - 1; index >= 0; index -= 1) {
		const event = events[index];
		if (event?.type === "tool/call" && event.data.callId === id) return event.seq;
	}
}
async function answerControl(input, query, message, turn, step) {
	const requestId = typeof message.request_id === "string" ? message.request_id : "";
	const request = message.request;
	const body = request !== null && typeof request === "object" ? request : {};
	const subtype = typeof body.subtype === "string" ? body.subtype : "";
	if (subtype === "can_use_tool") {
		query.send({
			type: "control_response",
			response: {
				subtype: "success",
				request_id: requestId,
				response: {
					allowed: true,
					updatedInput: body.input ?? {},
					tool_use_id: body.tool_use_id
				}
			}
		});
		return;
	}
	if (subtype === "mcp_message") {
		const mcp = body.message;
		const call = mcp !== null && typeof mcp === "object" ? mcp : { method: "" };
		const method = typeof call.method === "string" ? call.method : "";
		const id = "id" in call ? call.id : void 0;
		const params = "params" in call ? call.params : void 0;
		const result = await handleBridgeCall(input.ctx, input.agent, input.signal, {
			method,
			...id !== void 0 ? { id } : {},
			...params !== void 0 ? { params } : {}
		});
		if (result.executed) {
			const callId = ToolCallId(`bridge-${String(call.id ?? "call")}`);
			const raw = JSON.stringify(call.params ?? {});
			const recorded = input.session.append("tool/call", {
				turn,
				step,
				callId,
				name: BRIDGE_TOOL,
				arguments: raw
			});
			const first = result.body.content?.[0]?.text;
			const text = typeof first === "string" ? first : JSON.stringify(result.body);
			input.session.append("tool/result", {
				turn,
				step,
				message: createToolResultMessage({
					callId,
					content: [{
						type: "text",
						text
					}],
					isError: false
				})
			}, {
				surfaceOp: "append",
				sourceEventSeqs: [recorded.seq]
			});
		}
		query.send({
			type: "control_response",
			response: {
				subtype: "success",
				request_id: requestId,
				response: { mcp_response: {
					jsonrpc: "2.0",
					id: call.id ?? null,
					result: result.body
				} }
			}
		});
		return;
	}
	query.send({
		type: "control_response",
		response: {
			subtype: "error",
			request_id: requestId,
			error: `unsupported control ${subtype}`
		}
	});
}
function abortError() {
	return /* @__PURE__ */ new Error("codebuddy turn aborted");
}
/** Pending inbox that also records `agent/inbox/spliced`. */
var RecordingInbox = class {
	session;
	nextTurnMessages = [];
	nextStepMessages = [];
	constructor(session) {
		this.session = session;
	}
	get nextTurn() {
		return this.nextTurnMessages;
	}
	get nextStep() {
		return this.nextStepMessages;
	}
	clear() {
		this.splice("next-step", 0, this.nextStepMessages.length, []);
		this.splice("next-turn", 0, this.nextTurnMessages.length, []);
	}
	append(target, message) {
		const list = target === "next-turn" ? this.nextTurnMessages : this.nextStepMessages;
		this.splice(target, list.length, 0, [message]);
	}
	prepend(target, message) {
		this.splice(target, 0, 0, [message]);
	}
	replace(messageId, newMessage) {
		return this.replaceIn("next-turn", messageId, newMessage) || this.replaceIn("next-step", messageId, newMessage);
	}
	remove(messageId) {
		return this.removeIn("next-turn", messageId) || this.removeIn("next-step", messageId);
	}
	splice(target, start, deleteCount, inserted) {
		const removed = (target === "next-turn" ? this.nextTurnMessages : this.nextStepMessages).splice(start, deleteCount, ...inserted);
		this.session.append("agent/inbox/spliced", {
			target,
			start,
			removedCount: removed.length,
			inserted: [...inserted]
		});
		return removed;
	}
	replaceIn(target, messageId, message) {
		const index = (target === "next-turn" ? this.nextTurnMessages : this.nextStepMessages).findIndex((item) => item.id === messageId);
		if (index < 0) return false;
		this.splice(target, index, 1, [message]);
		return true;
	}
	removeIn(target, messageId) {
		const index = (target === "next-turn" ? this.nextTurnMessages : this.nextStepMessages).findIndex((item) => item.id === messageId);
		if (index < 0) return false;
		this.splice(target, index, 1, []);
		return true;
	}
};
/** Live CodeBuddy agent. One CLI process per turn; later turns pass `--resume`. */
var CodeBuddyAgent = class {
	host;
	presetHint;
	launch;
	readSelection;
	get id() {
		return this.session.id;
	}
	options;
	session;
	model;
	inbox;
	ctx;
	phase = "idle";
	turn = 0;
	idle = Promise.resolve();
	active;
	dispatch;
	/** CLI session id remembered for the next `--resume`, when one exists. */
	binding;
	constructor(host, session, options, presetHint, binding, launch, readSelection = () => ({
		lastUsed: null,
		pending: null
	})) {
		this.host = host;
		this.presetHint = presetHint;
		this.launch = launch;
		this.readSelection = readSelection;
		this.options = options;
		this.session = session;
		this.binding = binding;
		this.inbox = new RecordingInbox(session);
		const scope = createScope(host, this);
		this.ctx = scope.ctx;
		this.dispatch = agentEvents(host, this);
		this.model = new AgentModel(this.readSelection, session, options);
		this.session.append("model/selection", {
			provider: CODEBUDDY_PROVIDER,
			model: this.modelId()
		});
	}
	get status() {
		return this.phase;
	}
	/**
	* Preset selected for this session.
	* Later `agent-preset/selected` events replace the value from creation.
	* @returns the preset name, or `undefined` when the session has none.
	*/
	currentPreset() {
		const events = this.session.snapshotEvents();
		let preset = this.presetHint;
		for (const event of events) {
			const typed = event;
			if (typed.type !== "agent-preset/selected" || typed.data === null || typeof typed.data !== "object") continue;
			const value = typed.data.agentPreset;
			if (typeof value === "string") preset = value;
		}
		return preset;
	}
	cancel(cause) {
		this.inbox.clear();
		this.active?.abort(cause);
	}
	whenIdle() {
		return this.idle;
	}
	runMaintenance(task) {
		if (this.phase !== "idle") throw new Error("agent is busy");
		const signal = new AbortController();
		this.active = signal;
		return task(signal.signal);
	}
	send(message, target, wakeup) {
		this.inbox.append(target, message);
		if (wakeup) this.wake();
	}
	followup(message) {
		this.send(message, "next-turn", true);
	}
	steer(message) {
		this.send(message, "next-step", true);
	}
	inject(message) {
		this.send(message, "next-step", false);
	}
	/**
	* Model this agent reports for the current selection.
	*
	* The live selection wins. Selecting {@link DEFAULT_MODEL_ID}, or having no
	* selection at all, reports that id: the harness record must name something,
	* and the CLI resolves the concrete model itself.
	* @returns the model id to record and display.
	*/
	modelId() {
		return this.cliModel() === "" ? DEFAULT_MODEL_ID : this.cliModel();
	}
	/**
	* The `--model` value for the next CLI process.
	*
	* An empty string means "send no flag", which is how the CLI's own configured
	* model takes effect. {@link DEFAULT_MODEL_ID} is a synthetic selection that
	* maps to that empty string; it is never passed as an argument.
	* @returns the model id to pass, or an empty string to omit the flag.
	*/
	cliModel() {
		const chosen = this.model.current()?.model ?? "";
		if (chosen !== "" && chosen !== "default") return chosen;
		if (this.launch.model !== void 0 && this.launch.model !== "" && this.launch.model !== "default") return this.launch.model;
		return "";
	}
	wake() {
		if (this.phase === "running") return;
		const done = Promise.withResolvers();
		this.idle = done.promise;
		this.phase = "running";
		this.dispatch.emit("agent/status", { status: "running" });
		this.pump().finally(() => {
			this.phase = "idle";
			this.dispatch.emit("agent/status", { status: "idle" });
			done.resolve();
			if (this.inbox.nextTurn.length > 0) this.wake();
		});
	}
	async pump() {
		while (this.inbox.nextTurn.length > 0 || this.inbox.nextStep.length > 0) {
			const message = this.inbox.nextTurn[0] ?? this.inbox.nextStep[0];
			if (message === void 0) return;
			const target = this.inbox.nextTurn.length > 0 ? "next-turn" : "next-step";
			this.inbox.splice(target, 0, 1, []);
			let text;
			try {
				text = promptText(message);
			} catch (error) {
				const messageText = error instanceof Error ? error.message : "codebuddy turn failed";
				this.session.append("turn/start", { turn: this.turn + 1 });
				this.session.append("turn/end", {
					turn: this.turn + 1,
					reason: {
						kind: "error",
						error: {
							message: messageText,
							code: "UNSUPPORTED_INPUT"
						}
					}
				});
				this.turn += 1;
				continue;
			}
			this.turn += 1;
			const controller = new AbortController();
			this.active = controller;
			try {
				const creator = this.currentPreset() === CREATOR_PRESET;
				const model = this.cliModel();
				await runCliTurn({
					ctx: this.host,
					agent: this,
					session: this.session,
					turn: this.turn,
					message,
					prompt: text,
					creator,
					command: this.launch.command,
					args: this.launch.args,
					cwd: this.session.header.cwd ?? process.cwd(),
					...model !== "" ? { model } : {},
					recordModel: this.modelId(),
					...this.binding?.cliSessionId !== void 0 ? { resume: this.binding.cliSessionId } : {},
					graceMs: this.launch.graceMs,
					signal: controller.signal,
					dispatch: this.dispatch,
					onSession: async (id) => {
						this.binding = {
							cliSessionId: id,
							creator
						};
						await this.launch.remember(this.session.id, this.binding);
					}
				});
			} catch (error) {
				const messageText = error instanceof Error ? error.message : "codebuddy turn failed";
				this.session.append("turn/end", {
					turn: this.turn,
					reason: {
						kind: "error",
						error: {
							message: messageText,
							code: "CODEBUDDY"
						}
					}
				});
			}
		}
	}
};
//#endregion
//#region lib/types/probe.js
/**
* Fixed locations checked only after the plugin is explicitly enabled.
* `CODEBUDDY_BIN` is used only when it is already an absolute path.
* @param env - environment to read `CODEBUDDY_BIN` from.
* @returns absolute candidate paths, without searching `PATH`.
*/
function candidateCliPaths(env = process.env) {
	const home = homedir();
	const configured = env.CODEBUDDY_BIN;
	const paths = [
		...configured !== void 0 && isAbsolute(configured) ? [configured] : [],
		join(home, ".local", "bin", "codebuddy"),
		join(home, ".local", "bin", "cbc"),
		"/usr/local/bin/codebuddy",
		"/opt/homebrew/bin/codebuddy",
		"/usr/bin/codebuddy"
	];
	return [...new Set(paths)];
}
/**
* Resolve the CLI executable. An absolute `command` wins and is not probed.
* Probing stats candidates until the timeout; it never spawns or downloads.
* @param input - explicit command and probe budget.
* @returns the absolute executable path.
*/
async function resolveCliPath(input) {
	if (input.command !== "") {
		if (!isAbsolute(input.command)) throw new Error("codebuddy command must be an absolute path");
		await assertFile(input.command, input.timeoutMs);
		return input.command;
	}
	if (!input.probe) throw new Error("codebuddy command is empty and probing is disabled");
	const misses = [];
	for (const path of candidateCliPaths(input.env)) try {
		await assertFile(path, input.timeoutMs);
		return path;
	} catch (error) {
		misses.push(`${path}: ${error instanceof Error ? error.message : "missing"}`);
	}
	throw new Error(`codebuddy CLI was not found (${misses.join("; ")})`);
}
async function assertFile(path, timeoutMs) {
	const check = stat(path).then((info) => {
		if (!info.isFile()) throw new Error("not a file");
	});
	let timer;
	const timeout = new Promise((_resolve, reject) => {
		timer = setTimeout(() => reject(/* @__PURE__ */ new Error(`stat timed out after ${timeoutMs}ms`)), timeoutMs);
	});
	try {
		await Promise.race([check, timeout]);
	} finally {
		if (timer !== void 0) clearTimeout(timer);
	}
}
//#endregion
//#region lib/types/index.js
/**
* Agent factory that keeps the default loop for every provider except `codebuddy`.
* The profile disables the stock `agent-loop` row and inserts this service, so
* `setFactory` runs once.
*/
var CodeBuddyLoop = class extends AgentLoop {
	static inject = [
		...AgentLoop.inject,
		"subprocess",
		"codebuddySettings"
	];
	/** Plain holder so a traced createAgent call still sees the injected services. */
	locals;
	bindings = /* @__PURE__ */ new Map();
	/**
	* This loop's own handle on the model-selection projection.
	*
	* `AgentLoop` registers the same definition, and the registry shares one
	* registration between both holders, so re-registering here yields a reader
	* for the Session state the stock loop already folds. The CodeBuddy agent
	* reads it every turn instead of freezing a model at creation.
	*/
	modelProjection;
	constructor(ctx, config) {
		super(ctx, config);
		this.locals = { ctx };
		ctx.effect(() => registerCodeBuddyCatalog(ctx, ctx.codebuddySettings));
	}
	async [Service.init]() {
		await super[Service.init]();
		this.modelProjection = await this.locals.ctx.sessionProjections.register(modelSelectionProjectionDefinition);
	}
	get settings() {
		return this.locals.ctx.codebuddySettings.config;
	}
	async createAgent(ownerCtx, options) {
		if (providerOf(options.agentOptions) !== "codebuddy") return super.createAgent(ownerCtx, options);
		return this.openCodeBuddy(options.sessionId, options.agentOptions ?? {}, options.meta, false);
	}
	async resume(ownerCtx, options) {
		await this.ensureBindings();
		if (!this.bindings.has(options.resumeSessionId) && providerOf(options.agentOptions) !== "codebuddy") return super.resume(ownerCtx, options);
		return this.openCodeBuddy(options.resumeSessionId, options.agentOptions ?? {}, void 0, true);
	}
	async openCodeBuddy(sessionId, agentOptions, meta, resume) {
		if (!this.settings.enabled) throw new Error("codebuddy driver is disabled; set enabled: true on the plugin");
		await this.ensureBindings();
		const command = await resolveCliPath({
			command: this.settings.command,
			probe: this.settings.probe,
			timeoutMs: this.settings.probeTimeoutMs
		});
		const host = this.locals.ctx;
		const remembered = this.bindings.get(sessionId);
		const existing = resume ? host.sessions.get(sessionId) : void 0;
		const cwd = meta?.cwd ?? existing?.header.cwd ?? process.cwd();
		const session = existing ?? host.sessions.prepare(sessionId, { meta: { cwd } });
		if (existing === void 0) {
			host.sessions.enter(session);
			host.sessions.announce(session);
		}
		const agent = new CodeBuddyAgent(host, session, {
			...agentOptions,
			provider: CODEBUDDY_PROVIDER,
			model: this.settings.model || agentOptions.model || "default"
		}, meta?.agentPreset ?? (remembered?.creator ? "cordis" : void 0), remembered, {
			command,
			args: this.settings.args,
			model: this.settings.model,
			graceMs: this.settings.graceMs,
			remember: async (id, binding) => {
				this.bindings.set(id, binding);
				await writeBindings(this.settings.stateDir, this.bindings);
			}
		}, this.modelProjection.readerFor(session));
		const dispose = host.agents.register(agent);
		return {
			agent,
			dispose: async () => {
				agent.cancel({ kind: "disposed" });
				await agent.whenIdle();
				await dispose?.();
			}
		};
	}
	async ensureBindings() {
		if (this.bindings.size > 0 || this.settings.stateDir === "") return;
		this.bindings = await readBindings(this.settings.stateDir);
	}
};
function providerOf(options) {
	const provider = options?.provider;
	return typeof provider === "string" && provider.length > 0 ? provider : void 0;
}
//#endregion
export { CODEBUDDY_PROVIDER, CREATOR_PRESET, CodeBuddyLoop as default, initializeRequest, launchArgs };
