#!/usr/bin/env python3
"""Serve the real 20x mobile build with an isolated SQLite mock API.

The only POST action records the user's real inline button click. It sends no
agent reply and makes no model or tenant request. Requires aiohttp.
"""

import argparse
import asyncio
import json
import sqlite3
import time
from pathlib import Path
from aiohttp import web


parser = argparse.ArgumentParser()
parser.add_argument("profile", type=Path)
parser.add_argument("--port", type=int, default=20620)
args = parser.parse_args()
db = sqlite3.connect(args.profile / "pf-desktop.db", check_same_thread=False)
db.row_factory = sqlite3.Row
mobile_root = Path(__file__).resolve().parents[3] / "out" / "mobile"
clients = set()
epoch = "pr661-local-mock"
stream_seq = 0


def task(row):
    data = dict(row)
    for key in ("labels", "attachments", "repos", "output_fields", "skill_ids"):
        data[key] = json.loads(data[key] or "[]") if data.get(key) else ([] if key != "skill_ids" else None)
    for key in ("is_recurring", "heartbeat_enabled", "auto_start_agent", "auto_complete_without_review"):
        data[key] = bool(data.get(key))
    return data


def part(row):
    data = dict(row)
    return {"taskId":data["task_id"],"partId":data["part_id"],"seq":data["seq"],
            "role":data["role"],"content":data["content"],"partType":data["part_type"],
            "tool":json.loads(data["tool"]) if data["tool"] else None,
            "payload":json.loads(data["payload"]) if data["payload"] else None,
            "createdAt":data["created_at"],"updatedAt":data["updated_at"],"rev":data["rev"]}


def rows(sql, params=()):
    return db.execute(sql, params).fetchall()


async def broadcast(kind, payload):
    for client in list(clients):
        await client.send_json({"type":kind,"payload":payload})


async def api(request):
    global stream_seq
    path = request.path
    task_id = "mock-chat"
    if request.method == "GET":
        if path == "/api/tasks/open":
            return web.json_response([task(r) for r in rows("SELECT * FROM tasks WHERE status NOT IN ('completed','cancelled','expired') ORDER BY id")])
        if path == "/api/tasks/completed":
            return web.json_response({"tasks":[],"total":3})
        if path == f"/api/tasks/{task_id}":
            return web.json_response(task(rows("SELECT * FROM tasks WHERE id=?", (task_id,))[0]))
        if path == f"/api/tasks/{task_id}/limit-recovery":
            return web.json_response(None)
        if path == "/api/agents":
            return web.json_response([{**dict(r),"config":json.loads(r["config"]),"is_default":bool(r["is_default"])} for r in rows("SELECT * FROM agents")])
        if path == "/api/skills":
            return web.json_response([])
        if path == "/api/sessions":
            agent = rows("SELECT agent_id FROM tasks WHERE id=?", (task_id,))[0][0]
            return web.json_response([{"sessionId":"mock-local-session","agentId":agent,"taskId":task_id,"status":"idle"}])
        if path == f"/api/tasks/{task_id}/transcript/sync":
            since = request.query.get("sinceRev")
            all_parts = [part(r) for r in rows("SELECT * FROM transcript_parts WHERE task_id=? ORDER BY seq", (task_id,))]
            parts = all_parts if since is None else [p for p in all_parts if p["rev"] > int(since)]
            return web.json_response({"taskId":task_id,"epoch":epoch,"seq":stream_seq,
                                      "maxRev":max((p["rev"] for p in all_parts),default=0),
                                      "full":since is None,"parts":parts})
        if path == f"/api/tasks/{task_id}/artifacts":
            reg = json.loads((args.profile / "workspaces" / task_id / ".20x" / "artifacts.json").read_text())
            artifacts = []
            for a in reg["artifacts"]:
                target = f"artifacts/{a['artifactId']}/{a['entryFile']}"
                artifacts.append({"id":f"{task_id}:workpiece:{a['artifactId']}","taskId":task_id,
                                  "type":a["type"],"title":a["title"],"path":target,
                                  "workpieceKey":a["artifactId"],"files":[target],
                                  "updatedAt":a["updatedAt"],"reloadTrigger":a["updatedAt"],
                                  "inline":a.get("inline",False),"heightHint":a.get("heightHint")})
            return web.json_response(artifacts)
        if path == f"/api/tasks/{task_id}/artifacts/content":
            rel = request.query.get("path","")
            if rel != "artifacts/artifact_pr661_choices/choices.html":
                raise web.HTTPNotFound()
            content = (args.profile / "workspaces" / task_id / rel).read_text()
            return web.json_response({"kind":"text","content":content,"mimeType":"text/html"})
        if path == "/api/capabilities":
            return web.json_response({"voice":{"enabled":False}})
        raise web.HTTPNotFound()
    if request.method == "POST" and path == "/api/sessions/mock-local-session/send":
        body = await request.json()
        choice = body.get("inlineChoice")
        message = body.get("message")
        if not isinstance(choice,dict) or choice.get("sourceMessageId") != "mock-agent-card" or message != "Explore invoice reminders":
            raise web.HTTPBadRequest(text="Only the sample inline choice is allowed")
        now = int(time.time() * 1000)
        seq = rows("SELECT COALESCE(MAX(seq),0)+1 FROM transcript_parts WHERE task_id=?", (task_id,))[0][0]
        rev = rows("SELECT COALESCE(MAX(rev),0)+1 FROM transcript_parts")[0][0]
        with db:
            db.execute("""INSERT INTO transcript_parts
              (task_id,part_id,seq,role,content,part_type,payload,created_at,updated_at,rev)
              VALUES (?,?,?,'user',?, 'text',?,?,?,?)""",
              (task_id,f"mobile-click-{now}",seq,message,json.dumps({"inlineChoice":choice}),now,now,rev))
        created = part(rows("SELECT * FROM transcript_parts WHERE part_id=?", (f"mobile-click-{now}",))[0])
        stream_seq += 1
        await broadcast("transcript:changed", {"taskId":task_id,"epoch":epoch,"seq":stream_seq,
                                               "maxRev":rev,"ops":[{"op":"put","part":created}]})
        return web.json_response({"success":True})
    raise web.HTTPNotFound()


async def websocket(request):
    ws = web.WebSocketResponse()
    await ws.prepare(request)
    clients.add(ws)
    try:
        async for message in ws:
            if message.type == web.WSMsgType.TEXT:
                try:
                    if json.loads(message.data).get("type") == "ping":
                        await ws.send_json({"type":"pong","payload":{}})
                except json.JSONDecodeError:
                    pass
    finally:
        clients.discard(ws)
    return ws


app = web.Application()
app.router.add_route("*", "/api/{tail:.*}", api)
app.router.add_get("/ws", websocket)
app.router.add_static("/assets/", mobile_root / "assets")
app.router.add_get("/{tail:.*}", lambda request: web.FileResponse(mobile_root / "index.html"))
web.run_app(app, host="127.0.0.1", port=args.port)
