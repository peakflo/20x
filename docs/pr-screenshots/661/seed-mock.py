#!/usr/bin/env python3
"""Seed an isolated 20x profile for PR #661 screenshots.

Start the PR build once with --user-data-dir=PROFILE so 20x creates its schema,
then stop it and run: python3 seed-mock.py PROFILE.
No account, tenant, key, or real customer value is used.
"""

import argparse
import json
import sqlite3
from pathlib import Path


def js(value):
    return json.dumps(value, separators=(",", ":"))


parser = argparse.ArgumentParser()
parser.add_argument("profile", type=Path)
args = parser.parse_args()
db_path = args.profile / "pf-desktop.db"
if not db_path.exists():
    parser.error("Start 20x once with this profile first, so it creates pf-desktop.db")

db = sqlite3.connect(db_path)
now = "2026-10-31T08:00:00.000Z"
with db:
    db.execute("INSERT OR REPLACE INTO settings(key,value) VALUES (?,?)", ("setup_completed_version", "44.0.0"))
    db.execute("INSERT OR REPLACE INTO settings(key,value) VALUES (?,?)", ("mastermind_prewarm", "false"))
    agent_id = db.execute("SELECT id FROM agents WHERE is_default=1 LIMIT 1").fetchone()[0]
    # The invalid local model blocks any real model call if a demo button sends.
    db.execute("UPDATE agents SET config=? WHERE id=?", (js({
        "coding_agent":"opencode","model":"pr661/no-model",
        "permission_mode":"ask","mcp_servers":[],"skill_ids":[]}), agent_id))
    db.execute("""INSERT OR REPLACE INTO task_sources
        (id,name,list_tool,plugin_id,config,enabled,created_at,updated_at)
        VALUES ('mock-workflo','Local sample Workflo task','none','peakflo','{}',0,?,?)""", (now, now))

    def task(id, title, status, *, source="local", external_id=None, source_id=None, rating=None):
        db.execute("""INSERT OR REPLACE INTO tasks
          (id,title,description,status,priority,source,external_id,source_id,
           agent_id,feedback_rating,created_at,updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
          (id,title,"Sample data for PR #661. No real task or account.",status,"medium",
           source,external_id,source_id,agent_id,rating,now,now))

    task("mock-flow", "Review invoice 104", "ready_for_review", source="peakflo",
         external_id="mock-server-task", source_id="mock-workflo", rating=4)
    for n in (101, 102, 103):
        task(f"mock-done-{n}", f"Review invoice {n}", "completed")
    task("mock-chat", "Find an invoice reminder to automate", "ready_for_review")

    flow = {"id":"mock-server-task","title":"Review invoice 104","status":"in_progress",
            "spaceName":"Sample workspace","flowUses":[
              {"id":"mock-flow-use-1","executionId":"mock-run-1","versionId":"mock-v2",
               "version":2,"status":"trial","runStatus":"succeeded","outcome":"success",
               "judgeDecisions":[{"questionId":"invoice-match","verdict":"pass",
                                  "score":0.91,"judgeVersion":"judge-v3"}]},
              {"id":"mock-flow-use-2","executionId":"mock-run-2","versionId":"mock-v3",
               "version":3,"status":"active","runStatus":"succeeded","outcome":"success",
               "judgeDecisions":[{"questionId":"invoice-match","verdict":"pass",
                                  "score":0.96,"judgeVersion":"judge-v3"}]}]}
    db.execute("INSERT OR REPLACE INTO settings(key,value) VALUES (?,?)",
               ("workflo-task:mock-flow", js(flow)))

    def skill(id, name, description, content, scope="tenant", auto_attach=0):
        db.execute("""INSERT OR REPLACE INTO skills
          (id,name,description,content,version,confidence,tags,enterprise_scope,
           enterprise_auto_attach,created_at,updated_at)
          VALUES (?,?,?,?,1,0.8,'[]',?,?,?,?)""",
          (id,name,description,content,scope,auto_attach,now,now))

    skill("mock-skill", "invoice-review", "Review sample invoices and check the amount.",
          "# Invoice review\n\nCheck the amount and due date.")
    skill("mock-system", "self-improving-workflows", "Approved system guidance for flow candidates.",
          "# System skill\n\nUse approved flows for matching tasks.", "system", 1)
    held = {"name":"held-contact-draft","skillId":None,
            "data":{"name":"held-contact-draft","description":"Sample draft with a blocked contact value.",
                    "content":"Contact person@example.test","confidence":0.5,"tags":[]},
            "status":"held","guardCodes":["EMAIL_ADDRESS"],"createdAt":now}
    db.execute("INSERT OR REPLACE INTO settings(key,value) VALUES (?,?)",
               ("skill-edit-draft:held-contact-draft", js(held)))

    # A completed local tool part and a registered HTML artifact give the real
    # transcript and inline frame concrete data to display. No model is run.
    tool = {"name":"mcp__task_management__html_render","status":"success",
            "title":"Show sample choices","input":"artifact_pr661_choices",
            "output":"artifact_pr661_choices"}
    db.execute("DELETE FROM transcript_parts WHERE task_id='mock-chat'")
    db.execute("""INSERT INTO transcript_parts
      (task_id,part_id,seq,role,content,part_type,tool,payload,created_at,updated_at,rev)
      VALUES ('mock-chat','mock-agent-card',1,'assistant','Choose a next step.','tool',?,NULL,
              1793433600000,1793433600000,1)""", (js(tool),))

workspace = args.profile / "workspaces" / "mock-chat"
artifact = "artifact_pr661_choices"
artifact_dir = workspace / "artifacts" / artifact
artifact_dir.mkdir(parents=True, exist_ok=True)
html = """<!doctype html><html><head><meta charset='utf-8'><style>
body{font:14px system-ui,sans-serif;margin:0;padding:16px;color:#172030}
.card{border:1px solid #cbd5e1;border-radius:12px;padding:20px;background:#f8fafc}
h3{margin:0 0 6px}p{margin:0 0 16px;color:#475569}
button{background:#2563eb;color:white;border:0;border-radius:8px;padding:10px 16px;margin-right:8px;cursor:pointer}
button:disabled{background:#94a3b8;cursor:default}
</style></head><body><div class='card'><h3>Find an invoice reminder</h3>
<p>Choose how to continue with this sample task.</p>
<button onclick=\"workflo.sendMessage('Explore invoice reminders',{action:'explore',data:{area:'invoice-reminders'}})\">Explore</button>
<button onclick=\"workflo.sendMessage('Set a weekly reminder',{action:'schedule',data:{frequency:'weekly'}})\">Set a reminder</button>
</div></body></html>"""
(artifact_dir / "choices.html").write_text(html)
registry_dir = workspace / ".20x"
registry_dir.mkdir(parents=True, exist_ok=True)
registry = {"version":1,"artifacts":[{"artifactId":artifact,"taskId":"mock-chat",
    "title":"Invoice reminder choices","type":"html","files":["choices.html"],
    "entryFile":"choices.html","createdAt":1793433600000,"updatedAt":1793433600000,
    "inline":True,"heightHint":190}]}
(registry_dir / "artifacts.json").write_text(js(registry))
print(f"Seeded sample data in {args.profile}")
