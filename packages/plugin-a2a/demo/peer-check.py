#!/usr/bin/env python3
"""A2A-010 peer check: a non-opencode client holds a two-turn conversation.

Proves the inbound bridge speaks plain A2A: this script starts a task with
message/send, sends a reply on the same taskId, and reads both agent answers
back with tasks/get. Stdlib only — no a2a-sdk or third-party packages needed.

    python demo/peer-check.py http://<opencode-host>:<port>
"""

import json
import sys
import time
import urllib.request
import uuid

INTERRUPTED = {"TASK_STATE_INPUT_REQUIRED", "TASK_STATE_AUTH_REQUIRED"}
TERMINAL = {
    "TASK_STATE_COMPLETED",
    "TASK_STATE_FAILED",
    "TASK_STATE_CANCELED",
    "TASK_STATE_REJECTED",
}


def rpc(url, method, params, request_id):
    body = json.dumps({"jsonrpc": "2.0", "id": request_id, "method": method, "params": params}).encode()
    request = urllib.request.Request(
        url,
        data=body,
        headers={"content-type": "application/json", "x-a2a-peer": "peer-check.py"},
    )
    with urllib.request.urlopen(request) as response:
        payload = json.load(response)
    if "error" in payload:
        raise SystemExit(f"{method} failed: {payload['error']}")
    return payload["result"]


def agent_reply(task):
    agents = [m for m in task.get("history", []) if m.get("role") == "ROLE_AGENT"]
    if not agents:
        return "(no reply yet)"
    return "\n".join(part.get("text", "") for part in agents[-1].get("parts", []))


def send(url, text, task_id=None):
    message = {
        "messageId": f"peer-check-{uuid.uuid4()}",
        "role": "ROLE_USER",
        "parts": [{"text": text}],
    }
    if task_id:
        message["taskId"] = task_id
    return rpc(url, "message/send", {"message": message}, "send")


def wait_for(url, task_id, settled):
    deadline = time.time() + 120
    while time.time() < deadline:
        task = rpc(url, "tasks/get", {"id": task_id}, "get")
        if task["status"]["state"] in settled:
            return task
        time.sleep(0.5)
    raise SystemExit(f"timed out waiting for task {task_id}")


def main():
    if len(sys.argv) != 2:
        raise SystemExit("usage: python demo/peer-check.py http://<opencode-host>:<port>")
    base = sys.argv[1].rstrip("/")
    rpc_url = f"{base}/"

    with urllib.request.urlopen(f"{base}/.well-known/agent-card.json") as response:
        card = json.load(response)
    print(f"peer card: {card['name']} @ {base}")

    task = send(rpc_url, "Ping for peer check — what is 2+2?")
    task_id = task["id"]
    print(f"task {task_id} created ({task['status']['state']})")

    first = wait_for(rpc_url, task_id, INTERRUPTED | TERMINAL)
    print(f"turn 1 reply: {agent_reply(first)}")

    send(rpc_url, "Now double it.", task_id)
    second = wait_for(rpc_url, task_id, INTERRUPTED | TERMINAL)
    print(f"turn 2 reply: {agent_reply(second)}")
    print(f"final state: {second['status']['state']}")
    print("peer check passed: same taskId carried both turns and both replies came back.")


if __name__ == "__main__":
    main()
