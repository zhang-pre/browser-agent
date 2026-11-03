# Agent Runtime architecture

The Agent runtime is split into a platform-neutral core and Firefox adapters.
Dependency arrows must point from adapters toward the core, never back from the
core into privileged browser APIs.

## Layers

Sources are grouped under `additions/browser/components/agent-sidebar/modules/`:
`runtime/`, `llm/`, `providers/`,
`state/`, `tools/`, `backends/`, `host/`, and `mcp/`.
The [module directory guide](../additions/browser/components/agent-sidebar/modules/README.md)
maps responsibilities and installation paths. All callers must import these grouped
paths. Flat compatibility URLs have been removed; external scripts must migrate
to the grouped paths as well.

1. **AgentRuntimeCore** owns in-memory thread state, event reduction,
   subscriptions, confirmation state, cancellation, and window reservations.
   It has no Firefox imports and is directly testable in Node.
2. **AgentRuntimePorts** validates and attenuates the host capabilities exposed
   to the portable runtime: clock, config, conversations, LLM, tools, and
   lifecycle.
3. **AgentRuntime** is the platform-neutral composition root. It assembles the
   state core, turn orchestrator, loop, and normalized ports.
4. **AgentTurnOrchestrator** coordinates projection, persistence, usage,
   checkpoints, and automatic continuation.
5. **AgentLoop** is the decision engine. It receives an LLM client, a tool
   router, messages, limits, and callbacks. It does not know which browser or
   operating system executes a tool.
6. **LlmClient** is the stable facade over LlmProtocol, LlmStreamParser,
   LlmRequestExecutor, and LlmTransport. Fetch, abort controllers, and timers
   are supplied through the transport port. The subscription provider has a
   dedicated CodexResponses adapter and authentication layer.
7. **FirefoxAgentRuntimeHost** adapts Firefox timers, shutdown, ToolRouter,
   backends, transport, and opaque host contexts to the formal ports.
8. **AgentSession** is the thin Firefox entry point. It creates the ports and
   exports the process-lifetime shared runtime used by the sidebar and MCP.
9. **Backends and AgentEvalChild** implement capabilities. These are outside the
   runtime core and are reached only through ToolRouter dispatch.

## Runtime flow

```text
AgentPanel
  -> AgentSession
     -> FirefoxAgentRuntimeHost -> AgentRuntimePorts
     -> AgentRuntime
        -> AgentRuntimeCore
        -> AgentTurnOrchestrator
           -> LlmClient -> LlmRequestExecutor -> LlmTransport
           -> AgentLoop -> ToolRouter -> Firefox backends -> JSWindowActor/Gecko
```

## Context ownership

- **state/UnifiedContext** owns the persisted event log, task card, model-facing
  projection, compaction coverage and memory outbox. The conversation store keeps
  full UI history as well as this unified state.
- **state/UnifiedTurnContext** builds requests and applies one budget/compaction
  path across user turns. It accounts for tool schemas, reasoning/provider state,
  output reserve and a safety margin; incomplete tool groups cannot be committed.
- **runtime/AgentLoop** chooses safe boundaries and drives the unified context;
  it owns LLM/tool execution, steering consumption and loop guards.
- **runtime/AgentTurnOrchestrator** supplies persistence, evidence validation,
  checkpoint and usage callbacks. The context module uses injected callbacks
  rather than Firefox APIs or direct storage access.
- **state/ConversationMigration** imports older conversation state into the
  unified format; ContextProjection and TurnContext are no longer source modules.

Compaction uses the structured **MemoryContract** rather than Markdown heading
parsing. The summary and pending memory outbox are saved together; Ledger applies
batches with receipts so retries do not duplicate entries. The full source events
remain available for evidence checks. **CompletionMemory** separately checks
substantive successful runs for missing verified memory after showing the final
answer; its failure does not turn the completed task into a failed run.

`remember / recall` are the model-facing memory tools. Default recall and automatic
injection are scoped to the current workspace; cross-workspace reads are explicit.
Legacy Notes files are retained without being read or migrated. See the
[memory contract guide](../additions/browser/components/agent-sidebar/modules/README.md#压缩与记忆交接)
for evidence requirements, retry behavior and budget defaults.

## Steering the active run

- Idle Send starts a run. During a run, the UI sends text through
  `agentSession.steer(threadId, content)` and offers a separate Stop button.
- `steer` synchronously returns `{ ok, id }` or `{ ok: false, error }`.
  Acceptance means queued, not yet consumed. It never calls `run` or aborts.
- AgentRuntimeCore owns a per-run FIFO with snapshot receipts:
  `queued`, `applying`, `applied`, or `cancelled`. Up to 100 messages per run,
  at most 16,000 characters each. Snapshots do not expose mutable queue entries.
- AgentLoop reads the queue before requests and at response/tool boundaries.
  An active request or tool finishes normally; remaining unstarted tool calls
  get explicit skipped results before new user messages enter the model history.
  Pending approval is declined, never automatically granted by steering.
- Orchestrator persists consumed user messages. Corrections survive loop context
  compaction and are applied before the next model request.
- Finalization closes admission before persistence awaits. Rejected messages stay
  in the UI input. Stop aborts the current run and cancels unconsumed receipts.
  Queues are in memory, are not restored after process shutdown, and never carry
  into another run. Follow-up queues are not implemented.
- The UI fallback without a resident runtime does not support steering.

Run `bash scripts/selftest-agent-tools.sh` for mock-based regression coverage,
including `selftest-agent-steer.mjs`. No real provider requests are needed.

## Boundary rules

- Do not import `ChromeUtils`, `Services`, `IOUtils`, `PathUtils`, XPCOM,
  or browser backends from `AgentRuntimeCore`, `AgentLoop`, `LlmClient`, or
  `LlmTransport`.
- Pass the selected window, workspace, and cancellation signal through tool
  context instead of reading global focus state.
- Keep provider protocol conversion in the LLM protocol stack; keep API
  Key profiles in `ConfigStore` and subscription credentials in the authentication
  adapters. MCP credentials have their own host storage.
- Keep session persistence in `AgentTurnOrchestrator`/conversation ports, not in the
  state kernel.
- New built-in privileged capabilities must be implemented as backends and
  registered in `Tools.sys.mjs`; they must not be called directly by the decision
  engine. Dynamic MCP capabilities enter through the MCP manager/host adapter.
- A non-Firefox host can reuse the core by supplying timers, lifecycle hooks, an
  LLM transport, a router, and persistence adapters.

## Extension points

- **New scheduling policy:** extend `AgentTurnOrchestrator` while keeping
  `AgentLoop.runAgentTurn` platform-neutral.
- **New model protocol:** add protocol codecs in `LlmProtocol`; transport stays
  unchanged.
- **Proxy, replay, or offline inference:** inject a different `LlmTransport`.
- **New browser capability:** add a backend, wire it in `Backends.sys.mjs`, and
  declare its public schema in `Tools.sys.mjs`.
- **New host application:** compose `AgentRuntimeCore` with a host adapter
  equivalent to `FirefoxAgentRuntimeHost`.
