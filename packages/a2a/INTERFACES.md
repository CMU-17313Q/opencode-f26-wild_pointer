# A2A Interfaces

JSON-RPC 2.0 over HTTPS POST to the AgentCard's `JSONRPC` interface URL.
Schemas in `src/types.ts`. Parts are text-only.

## Calls

```
# Start work. Returns Message when done, Task when async (then poll tasks/get).
message/send(message: Message, configuration?) -> Task | Message

# Same as send, but streams progress events until a terminal state.
message/stream(message: Message, configuration?) -> stream<Event>

# Read, enumerate, stop.
tasks/get(id: string) -> Task
tasks/list(contextId?, status?) -> { tasks: Task[], nextPageToken }
tasks/cancel(id: string) -> Task   # -> TASK_STATE_CANCELED

# Agent discovery (plain GET, not JSON-RPC).
GET {origin}/.well-known/agent-card.json -> AgentCard
```

## Shapes (wire names are camelCase)

```
Message { messageId, role: ROLE_USER | ROLE_AGENT, parts: Part[1..], contextId?, taskId? }
Part    { text, mediaType? }
Task    { id, status: { state, message?, timestamp? }, contextId?, history?: Message[] }
TaskState = SUBMITTED | WORKING | COMPLETED | FAILED | CANCELED
          | INPUT_REQUIRED | AUTH_REQUIRED
AgentCard { name, description, version, supportedInterfaces, capabilities,
            defaultInputModes, defaultOutputModes, skills }
```

## Notes

- Terminal: `COMPLETED FAILED CANCELED REJECTED`.
  Interrupted (client must act): `INPUT_REQUIRED AUTH_REQUIRED`.
- Errors: `-32001` not found, `-32002` not cancellable,
  `-32003` unsupported, `-32602` bad params.
