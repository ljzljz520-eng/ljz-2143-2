#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
校园活动签到系统 —— 服务端（仅依赖 Python 标准库）

架构要点
========
1. 事件溯源：签到 / 补签 / 撤销 / 再次入场全部作为独立事件追加到 events 表，
   绝不只覆盖布尔字段；checkin_state 是由事件流推导出的物化状态，可随时重算。
2. 计数策略（选型见 README）：
   - 在线扫码：单事务强一致（BEGIN IMMEDIATE + 状态表主键约束），立即计入「确认人数」。
   - 离线暂存：凭 HMAC 签名票据离线扫码，联网后批量合并，先计入「暂定人数」，
     冲突由工作台处置、确认后转入「确认人数」。
3. 幂等：客户端生成 event_id，服务端唯一约束去重 —— “服务器成功而终端重试”安全。
4. 票据绑定场次与有效时间窗；换场后旧队列只会进入原场次的冲突区，绝不计入新场次。
5. 当前场次与人数在同一读事务中取出，大屏原子切换。
"""

import argparse
import hashlib
import hmac
import json
import os
import re
import sqlite3
import threading
import time
import uuid
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit, parse_qs

# ---------------------------------------------------------------- 基础工具

DB_PATH = "checkin.db"
SECRET = "dev-secret-change-me"

CHECKIN_KINDS = ("CHECKIN", "SUPPLEMENT", "REENTRY")  # 签到类事件（补签/再次入场同属）
SESSION_SWITCH = "SESSION_SWITCH"


def now_iso():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


def iso_to_epoch(ts):
    return datetime.fromisoformat(ts.replace("Z", "+00:00")).timestamp()


def new_id():
    return uuid.uuid4().hex


def get_db():
    conn = sqlite3.connect(DB_PATH, timeout=15)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=8000")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


SCHEMA = """
CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  starts_at   TEXT,
  ends_at     TEXT,
  status      TEXT NOT NULL DEFAULT 'scheduled',  -- scheduled/active/closed
  is_current  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS eligibility (            -- 参与资格（持久化）
  session_id  TEXT NOT NULL,
  person_id   TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  PRIMARY KEY (session_id, person_id)
);

CREATE TABLE IF NOT EXISTS events (                 -- 事件溯源日志（只追加）
  seq         INTEGER PRIMARY KEY AUTOINCREMENT,    -- 全局单调序号 → 设备同步游标
  event_id    TEXT NOT NULL UNIQUE,                 -- 客户端幂等键
  session_id  TEXT NOT NULL,
  person_id   TEXT NOT NULL DEFAULT '',
  type        TEXT NOT NULL,  -- CHECKIN/SUPPLEMENT/REENTRY/REVOKE/SESSION_SWITCH
  source      TEXT NOT NULL,  -- online/offline_merge/admin
  device_id   TEXT,
  status      TEXT NOT NULL,  -- confirmed/tentative/duplicate/conflict/rejected
  resolution  TEXT,           -- 冲突处置：accepted/rejected
  client_ts   TEXT,           -- 终端本地时间（离线扫码时刻）
  server_ts   TEXT NOT NULL,
  note        TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_sp  ON events(session_id, person_id);
CREATE INDEX IF NOT EXISTS idx_events_seq ON events(seq);

CREATE TABLE IF NOT EXISTS checkin_state (          -- 由事件流推导的物化状态
  session_id    TEXT NOT NULL,
  person_id     TEXT NOT NULL,
  state         TEXT NOT NULL,        -- valid / revoked
  quality       TEXT NOT NULL,        -- confirmed / tentative（当前有效签到的成色）
  last_event_id TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  PRIMARY KEY (session_id, person_id)   -- 同场同人只可能有一行 → 只形成一个有效签到
);

CREATE TABLE IF NOT EXISTS devices (                -- 设备同步进度（持久化）
  id            TEXT PRIMARY KEY,
  name          TEXT,
  last_seq      INTEGER NOT NULL DEFAULT 0,         -- 已同步到的事件序号
  last_sync_at  TEXT,                               -- 最近一次拉取事件流
  last_push_at  TEXT                                -- 最近一次离线合并上报
);

CREATE TABLE IF NOT EXISTS visuals (                -- 主视觉（版本化，原子发布）
  id           TEXT PRIMARY KEY,
  session_id   TEXT,                                -- NULL = 全局默认
  title        TEXT,
  image_url    TEXT,
  bg_color     TEXT,
  version      INTEGER NOT NULL,
  is_published INTEGER NOT NULL DEFAULT 0,
  published_at TEXT
);
"""


def init_db():
    conn = get_db()
    conn.executescript(SCHEMA)
    conn.commit()
    conn.close()


# ---------------------------------------------------------------- 离线票据
# 票据格式: CK1.<sid>.<pid>.<iat>.<exp>.<nonce>.<sig>
# sig = HMAC_SHA256(secret, "CK1.sid.pid.iat.exp.nonce")[:32]
# 票据绑定场次(sid)与有效范围[iat, exp]，换场后无法挪用到新场次。

def _ticket_msg(sid, pid, iat, exp, nonce):
    return f"CK1.{sid}.{pid}.{iat}.{exp}.{nonce}"


def make_ticket(sid, pid, iat, exp):
    nonce = new_id()[:12]
    msg = _ticket_msg(sid, pid, iat, exp, nonce)
    sig = hmac.new(SECRET.encode(), msg.encode(), hashlib.sha256).hexdigest()[:32]
    return f"{msg}.{sig}"


def parse_ticket(ticket):
    parts = (ticket or "").strip().split(".")
    if len(parts) != 7 or parts[0] != "CK1":
        raise ValueError("BAD_TICKET_FORMAT")
    _, sid, pid, iat, exp, nonce, sig = parts
    msg = _ticket_msg(sid, pid, iat, exp, nonce)
    expect = hmac.new(SECRET.encode(), msg.encode(), hashlib.sha256).hexdigest()[:32]
    if not hmac.compare_digest(expect, sig):
        raise ValueError("BAD_TICKET_SIGNATURE")
    return {"session_id": sid, "person_id": pid, "iat": int(iat), "exp": int(exp)}


# ---------------------------------------------------------------- 核心判定

def _last_revoke_ts(conn, session_id, person_id):
    row = conn.execute(
        "SELECT server_ts FROM events WHERE session_id=? AND person_id=? "
        "AND type='REVOKE' ORDER BY seq DESC LIMIT 1",
        (session_id, person_id)).fetchone()
    return row["server_ts"] if row else None


def apply_event(conn, *, event_id, session_id, person_id, ev_type, source,
                device_id=None, client_ts=None, note=""):
    """在写事务内应用一条事件。返回判定结果。幂等：event_id 已存在直接回旧结果。"""
    dup = conn.execute("SELECT status, type, note FROM events WHERE event_id=?",
                       (event_id,)).fetchone()
    if dup:
        return {"event_id": event_id, "status": dup["status"], "type": dup["type"],
                "note": dup["note"] or "", "effective": False, "idempotent": True}

    server_ts = now_iso()
    st = conn.execute(
        "SELECT state, quality FROM checkin_state WHERE session_id=? AND person_id=?",
        (session_id, person_id)).fetchone()

    final_type, status, effective, new_state, quality = ev_type, None, False, None, None

    if ev_type in CHECKIN_KINDS:
        sess = conn.execute("SELECT status FROM sessions WHERE id=?",
                            (session_id,)).fetchone()
        if sess is None:
            status, note = "rejected", note or "UNKNOWN_SESSION"
        elif source == "offline_merge" and sess["status"] == "closed":
            # 换场封场后迟到的离线队列 → 冲突区，绝不计入新场次人数
            status, note = "conflict", note or "SESSION_CLOSED"
        elif source == "online" and sess["status"] != "active":
            status, note = "rejected", note or "SESSION_NOT_ACTIVE"
        elif st is None:
            effective, new_state = True, "valid"
            status = "confirmed" if source in ("online", "admin") else "tentative"
            quality = status
        elif st["state"] == "valid":
            status, note = "duplicate", note or "ALREADY_VALID"  # 同场重复扫码
        else:  # 曾撤销
            last_rev = _last_revoke_ts(conn, session_id, person_id)
            if (source == "offline_merge" and client_ts and last_rev
                    and client_ts < last_rev):
                # 撤销前扫的、撤销后才到 → 冲突，待人工处置
                status, note = "conflict", note or "LATE_AFTER_REVOKE"
            else:
                # 撤销之后的再次入场：独立事件，状态重新有效
                effective, new_state = True, "valid"
                status = "confirmed" if source in ("online", "admin") else "tentative"
                quality = status
                if final_type == "CHECKIN":
                    final_type = "REENTRY"
    elif ev_type == "REVOKE":
        if st and st["state"] == "valid":
            effective, new_state, status, quality = True, "revoked", "confirmed", "confirmed"
        else:
            status, note = "rejected", note or "NO_VALID_CHECKIN"
    else:
        status, note = "rejected", note or "UNKNOWN_TYPE"

    conn.execute(
        "INSERT INTO events(event_id,session_id,person_id,type,source,device_id,"
        "status,client_ts,server_ts,note) VALUES(?,?,?,?,?,?,?,?,?,?)",
        (event_id, session_id, person_id, final_type, source, device_id,
         status, client_ts, server_ts, note))

    if effective and new_state == "valid":
        conn.execute(
            "INSERT INTO checkin_state(session_id,person_id,state,quality,"
            "last_event_id,updated_at) VALUES(?,?,?,?,?,?) "
            "ON CONFLICT(session_id,person_id) DO UPDATE SET state='valid',"
            "quality=excluded.quality,last_event_id=excluded.last_event_id,"
            "updated_at=excluded.updated_at",
            (session_id, person_id, "valid", quality, event_id, server_ts))
    elif effective and new_state == "revoked":
        conn.execute(
            "UPDATE checkin_state SET state='revoked',last_event_id=?,updated_at=? "
            "WHERE session_id=? AND person_id=?",
            (event_id, server_ts, session_id, person_id))

    return {"event_id": event_id, "status": status, "type": final_type,
            "note": note, "effective": effective, "idempotent": False}


def session_counts(conn, session_id):
    row = conn.execute(
        "SELECT "
        " SUM(CASE WHEN state='valid' AND quality='confirmed' THEN 1 ELSE 0 END) c,"
        " SUM(CASE WHEN state='valid' AND quality='tentative' THEN 1 ELSE 0 END) t,"
        " SUM(CASE WHEN state='revoked' THEN 1 ELSE 0 END) r "
        "FROM checkin_state WHERE session_id=?", (session_id,)).fetchone()
    confirmed = row["c"] or 0
    pending = row["t"] or 0
    return {"confirmed": confirmed, "tentative_pending": pending,
            "tentative_total": confirmed + pending, "revoked": row["r"] or 0}


def recalculate(conn, session_id):
    """按 seq 重放事件流，重建 checkin_state。返回校正报告。"""
    before = session_counts(conn, session_id)
    persons = {}
    rows = conn.execute(
        "SELECT * FROM events WHERE session_id=? AND person_id!='' ORDER BY seq",
        (session_id,)).fetchall()
    for ev in rows:
        p = persons.setdefault(ev["person_id"], {"state": None, "quality": None,
                                                 "last_event_id": None})
        if ev["status"] == "rejected" or ev["resolution"] == "rejected":
            continue
        if ev["status"] == "conflict" and ev["resolution"] != "accepted":
            continue  # 未处置冲突不生效
        if ev["type"] in CHECKIN_KINDS:
            if p["state"] != "valid":
                p["state"] = "valid"
                p["quality"] = ("confirmed" if ev["status"] == "confirmed"
                                or ev["resolution"] == "accepted" else "tentative")
                p["last_event_id"] = ev["event_id"]
        elif ev["type"] == "REVOKE":
            if p["state"] == "valid":
                p["state"], p["quality"] = "revoked", "confirmed"
                p["last_event_id"] = ev["event_id"]

    corrections, ts = [], now_iso()
    existing = {r["person_id"]: r for r in conn.execute(
        "SELECT * FROM checkin_state WHERE session_id=?", (session_id,)).fetchall()}
    for pid, want in persons.items():
        if want["state"] is None:
            continue
        cur = existing.pop(pid, None)
        if cur is None:
            conn.execute(
                "INSERT INTO checkin_state(session_id,person_id,state,quality,"
                "last_event_id,updated_at) VALUES(?,?,?,?,?,?)",
                (session_id, pid, want["state"], want["quality"],
                 want["last_event_id"], ts))
            corrections.append({"person_id": pid, "before": None,
                                "after": f'{want["state"]}/{want["quality"]}'})
        elif cur["state"] != want["state"] or cur["quality"] != want["quality"]:
            conn.execute(
                "UPDATE checkin_state SET state=?,quality=?,last_event_id=?,"
                "updated_at=? WHERE session_id=? AND person_id=?",
                (want["state"], want["quality"], want["last_event_id"], ts,
                 session_id, pid))
            corrections.append({"person_id": pid,
                                "before": f'{cur["state"]}/{cur["quality"]}',
                                "after": f'{want["state"]}/{want["quality"]}'})
    for pid in existing:  # 事件流中已不存在有效轨迹的残留行
        conn.execute("DELETE FROM checkin_state WHERE session_id=? AND person_id=?",
                     (session_id, pid))
        corrections.append({"person_id": pid,
                            "before": f'{existing[pid]["state"]}/'
                                      f'{existing[pid]["quality"]}', "after": None})
    return {"session_id": session_id, "corrections": corrections,
            "counts_before": before, "counts_after": session_counts(conn, session_id)}


# ---------------------------------------------------------------- HTTP 层

STATIC_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")


def record_switch_event(conn, session_id, name):
    conn.execute(
        "INSERT INTO events(event_id,session_id,person_id,type,source,status,"
        "server_ts,note) VALUES(?,?,?,?,?,?,?,?)",
        (new_id(), session_id, "", SESSION_SWITCH, "admin", "confirmed",
         now_iso(), name))


class ApiError(Exception):
    def __init__(self, code, msg):
        self.code, self.msg = code, msg


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    # ---- 基础设施 ----
    def log_message(self, fmt, *args):
        pass

    def _send_json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _send_html(self, name):
        path = os.path.join(STATIC_DIR, name)
        with open(path, "rb") as f:
            body = f.read()
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _body(self):
        n = int(self.headers.get("Content-Length") or 0)
        if not n:
            return {}
        return json.loads(self.rfile.read(n).decode("utf-8"))

    def _require(self, d, *keys):
        for k in keys:
            if d.get(k) in (None, ""):
                raise ApiError(400, f"missing field: {k}")

    # ---- 路由 ----
    def do_GET(self):
        try:
            self._route_get(urlsplit(self.path))
        except ApiError as e:
            self._send_json(e.code, {"ok": False, "error": e.msg})
        except Exception as e:  # noqa
            self._send_json(500, {"ok": False, "error": f"{type(e).__name__}: {e}"})

    def do_POST(self):
        try:
            self._route_post(urlsplit(self.path))
        except ApiError as e:
            self._send_json(e.code, {"ok": False, "error": e.msg})
        except json.JSONDecodeError:
            self._send_json(400, {"ok": False, "error": "invalid json"})
        except Exception as e:  # noqa
            self._send_json(500, {"ok": False, "error": f"{type(e).__name__}: {e}"})

    def _route_get(self, u):
        p, q = u.path, parse_qs(u.query)
        if p == "/":
            self.send_response(302)
            self.send_header("Location", "/admin")
            self.send_header("Content-Length", "0")
            self.end_headers()
        elif p == "/screen":
            self._send_html("screen.html")
        elif p == "/admin":
            self._send_html("admin.html")
        elif p == "/api/screen/state":
            self._api_screen_state()
        elif p == "/api/sessions":
            self._api_sessions_list()
        elif p == "/api/events":
            self._api_events(q)
        elif p == "/api/admin/conflicts":
            self._api_conflicts(q)
        elif p == "/api/devices":
            self._api_devices()
        elif p == "/api/sync/events":
            self._api_sync_events(q)
        elif re.fullmatch(r"/api/sessions/[^/]+/eligibility", p):
            self._api_eligibility_list(p.split("/")[3])
        else:
            raise ApiError(404, "not found")

    def _route_post(self, u):
        p = u.path
        m = re.fullmatch(r"/api/sessions/([^/]+)/(activate|close|eligibility)", p)
        if p == "/api/sessions":
            self._api_session_create()
        elif m and m.group(2) == "activate":
            self._api_session_activate(m.group(1))
        elif m and m.group(2) == "close":
            self._api_session_close(m.group(1))
        elif m and m.group(2) == "eligibility":
            self._api_eligibility_import(m.group(1))
        elif p == "/api/tickets":
            self._api_ticket_issue()
        elif p == "/api/checkin":
            self._api_checkin()
        elif p == "/api/sync/merge":
            self._api_sync_merge()
        elif p == "/api/devices/register":
            self._api_device_register()
        elif p == "/api/admin/supplement":
            self._api_supplement()
        elif p == "/api/admin/revoke":
            self._api_revoke()
        elif p == "/api/admin/confirm":
            self._api_confirm()
        elif p == "/api/admin/conflicts/resolve":
            self._api_conflict_resolve()
        elif p == "/api/admin/recalculate":
            self._api_recalculate()
        elif p == "/api/visuals/publish":
            self._api_visual_publish()
        else:
            raise ApiError(404, "not found")

    # ---- 大屏：当前场次 + 人数 + 主视觉，同一读事务原子取出 ----
    def _api_screen_state(self):
        conn = get_db()
        try:
            conn.execute("BEGIN")
            sess = conn.execute(
                "SELECT * FROM sessions WHERE is_current=1 LIMIT 1").fetchone()
            counts, session = None, None
            if sess:
                session = {"id": sess["id"], "name": sess["name"],
                           "starts_at": sess["starts_at"], "ends_at": sess["ends_at"],
                           "status": sess["status"]}
                counts = session_counts(conn, sess["id"])
                vis = conn.execute(
                    "SELECT * FROM visuals WHERE is_published=1 AND "
                    "(session_id=? OR session_id IS NULL) "
                    "ORDER BY (session_id IS NULL), version DESC LIMIT 1",
                    (sess["id"],)).fetchone()
            else:
                vis = conn.execute(
                    "SELECT * FROM visuals WHERE is_published=1 AND session_id IS NULL "
                    "ORDER BY version DESC LIMIT 1").fetchone()
            visual = ({"version": vis["version"], "title": vis["title"],
                       "image_url": vis["image_url"], "bg_color": vis["bg_color"]}
                      if vis else None)
            max_seq = conn.execute("SELECT COALESCE(MAX(seq),0) s FROM events").fetchone()["s"]
            conn.execute("COMMIT")
            self._send_json(200, {"ok": True, "server_ts": now_iso(),
                                  "session": session, "counts": counts,
                                  "visual": visual, "max_seq": max_seq})
        finally:
            conn.close()

    # ---- 场次管理 ----
    def _api_session_create(self):
        d = self._body()
        self._require(d, "name")
        sid, ts = new_id(), now_iso()
        conn = get_db()
        try:
            conn.execute("BEGIN IMMEDIATE")
            conn.execute(
                "INSERT INTO sessions(id,name,starts_at,ends_at,status,created_at) "
                "VALUES(?,?,?,?, 'scheduled', ?)",
                (sid, d["name"], d.get("starts_at"), d.get("ends_at"), ts))
            conn.execute("COMMIT")
            self._send_json(200, {"ok": True, "session_id": sid})
        finally:
            conn.close()

    def _api_session_activate(self, sid):
        """原子换场：同事务内封旧场、开新场、记切换事件、人数随场次指针原子切换。"""
        conn = get_db()
        try:
            conn.execute("BEGIN IMMEDIATE")
            sess = conn.execute("SELECT * FROM sessions WHERE id=?", (sid,)).fetchone()
            if not sess:
                raise ApiError(404, "session not found")
            conn.execute("UPDATE sessions SET is_current=0, "
                         "status=CASE WHEN status='active' THEN 'closed' ELSE status END "
                         "WHERE is_current=1 AND id<>?", (sid,))
            conn.execute("UPDATE sessions SET is_current=1, status='active' WHERE id=?",
                         (sid,))
            record_switch_event(conn, sid, sess["name"])
            counts = session_counts(conn, sid)
            conn.execute("COMMIT")
            self._send_json(200, {"ok": True, "session_id": sid, "counts": counts})
        finally:
            conn.close()

    def _api_session_close(self, sid):
        conn = get_db()
        try:
            conn.execute("BEGIN IMMEDIATE")
            conn.execute("UPDATE sessions SET status='closed', is_current=0 WHERE id=?",
                         (sid,))
            conn.execute("COMMIT")
            self._send_json(200, {"ok": True})
        finally:
            conn.close()

    def _api_sessions_list(self):
        conn = get_db()
        try:
            out = []
            for s in conn.execute("SELECT * FROM sessions ORDER BY created_at"):
                c = session_counts(conn, s["id"])
                conflicts = conn.execute(
                    "SELECT COUNT(*) n FROM events WHERE session_id=? AND "
                    "status='conflict' AND resolution IS NULL", (s["id"],)).fetchone()["n"]
                elig = conn.execute(
                    "SELECT COUNT(*) n FROM eligibility WHERE session_id=?",
                    (s["id"],)).fetchone()["n"]
                out.append({"id": s["id"], "name": s["name"], "status": s["status"],
                            "is_current": s["is_current"], "starts_at": s["starts_at"],
                            "ends_at": s["ends_at"], "counts": c,
                            "conflicts_pending": conflicts, "eligible": elig})
            self._send_json(200, {"ok": True, "sessions": out})
        finally:
            conn.close()

    # ---- 参与资格 ----
    def _api_eligibility_import(self, sid):
        d = self._body()
        persons = d.get("person_ids") or []
        if not isinstance(persons, list) or not persons:
            raise ApiError(400, "person_ids must be a non-empty list")
        conn = get_db()
        try:
            conn.execute("BEGIN IMMEDIATE")
            ts = now_iso()
            for pid in persons:
                pid = str(pid).strip()
                if pid:
                    conn.execute(
                        "INSERT OR IGNORE INTO eligibility(session_id,person_id,"
                        "created_at) VALUES(?,?,?)", (sid, pid, ts))
            conn.execute("COMMIT")
            self._send_json(200, {"ok": True, "imported": len(persons)})
        finally:
            conn.close()

    def _api_eligibility_list(self, sid):
        conn = get_db()
        try:
            rows = conn.execute(
                "SELECT person_id, created_at FROM eligibility WHERE session_id=? "
                "ORDER BY person_id", (sid,)).fetchall()
            self._send_json(200, {"ok": True,
                                  "persons": [dict(r) for r in rows]})
        finally:
            conn.close()

    # ---- 票据签发（绑定场次 + 有效范围）----
    def _api_ticket_issue(self):
        d = self._body()
        self._require(d, "session_id", "person_id")
        valid = int(d.get("valid_seconds", 4 * 3600))
        conn = get_db()
        try:
            if not conn.execute("SELECT 1 FROM sessions WHERE id=?",
                                (d["session_id"],)).fetchone():
                raise ApiError(404, "session not found")
            if d.get("auto_grant"):
                conn.execute(
                    "INSERT OR IGNORE INTO eligibility(session_id,person_id,created_at)"
                    " VALUES(?,?,?)", (d["session_id"], d["person_id"], now_iso()))
                conn.commit()
            elif not conn.execute(
                    "SELECT 1 FROM eligibility WHERE session_id=? AND person_id=?",
                    (d["session_id"], d["person_id"])).fetchone():
                raise ApiError(403, "person not eligible for this session")
            now = int(time.time())
            ticket = make_ticket(d["session_id"], d["person_id"], now, now + valid)
            self._send_json(200, {"ok": True, "ticket": ticket,
                                  "iat": now, "exp": now + valid})
        finally:
            conn.close()

    # ---- 在线签到（强一致）----
    def _api_checkin(self):
        d = self._body()
        self._require(d, "event_id", "device_id")
        conn = get_db()
        try:
            conn.execute("BEGIN IMMEDIATE")
            if d.get("ticket"):
                try:
                    t = parse_ticket(d["ticket"])
                except ValueError as e:
                    raise ApiError(400, str(e))
                if not (t["iat"] <= time.time() <= t["exp"]):
                    raise ApiError(403, "TICKET_EXPIRED")
                sid, pid = t["session_id"], t["person_id"]
            else:
                self._require(d, "session_id", "person_id")
                sid, pid = d["session_id"], d["person_id"]
                if not conn.execute(
                        "SELECT 1 FROM eligibility WHERE session_id=? AND person_id=?",
                        (sid, pid)).fetchone():
                    conn.execute("COMMIT")
                    self._send_json(200, {"ok": True, "result": {
                        "event_id": d["event_id"], "status": "rejected",
                        "type": "CHECKIN", "note": "NOT_ELIGIBLE",
                        "effective": False, "idempotent": False}})
                    return
            res = apply_event(conn, event_id=d["event_id"], session_id=sid,
                              person_id=pid, ev_type="CHECKIN", source="online",
                              device_id=d["device_id"], client_ts=d.get("client_ts"))
            counts = session_counts(conn, sid)
            conn.execute("COMMIT")
            self._send_json(200, {"ok": True, "result": res, "counts": counts})
        finally:
            conn.close()

    # ---- 离线暂存合并（暂定人数）----
    def _api_sync_merge(self):
        d = self._body()
        self._require(d, "device_id")
        events = d.get("events") or []
        conn = get_db()
        try:
            conn.execute("BEGIN IMMEDIATE")
            results = []
            for ev in events:
                try:
                    t = parse_ticket(ev.get("ticket"))
                except ValueError as e:
                    results.append({"event_id": ev.get("event_id"),
                                    "status": "rejected", "note": str(e),
                                    "effective": False})
                    continue
                scan_ts = ev.get("client_ts")
                scan_epoch = iso_to_epoch(scan_ts) if scan_ts else time.time()
                if not (t["iat"] <= scan_epoch <= t["exp"]):
                    results.append({"event_id": ev.get("event_id"),
                                    "status": "rejected", "note": "TICKET_EXPIRED",
                                    "effective": False})
                    continue
                res = apply_event(conn, event_id=ev.get("event_id") or new_id(),
                                  session_id=t["session_id"], person_id=t["person_id"],
                                  ev_type="CHECKIN", source="offline_merge",
                                  device_id=d["device_id"], client_ts=scan_ts)
                results.append(res)
            conn.execute(
                "INSERT INTO devices(id,name,last_push_at) VALUES(?,?,?) "
                "ON CONFLICT(id) DO UPDATE SET last_push_at=excluded.last_push_at",
                (d["device_id"], d.get("device_name") or d["device_id"], now_iso()))
            conn.execute("COMMIT")
            self._send_json(200, {"ok": True, "results": results})
        finally:
            conn.close()

    # ---- 设备与同步进度 ----
    def _api_device_register(self):
        d = self._body()
        did = d.get("device_id") or new_id()
        conn = get_db()
        try:
            conn.execute(
                "INSERT INTO devices(id,name,last_sync_at) VALUES(?,?,?) "
                "ON CONFLICT(id) DO UPDATE SET name=excluded.name",
                (did, d.get("name") or did, now_iso()))
            conn.commit()
            self._send_json(200, {"ok": True, "device_id": did})
        finally:
            conn.close()

    def _api_sync_events(self, q):
        """设备拉取事件流；SESSION_SWITCH 事件提示设备清空旧场次暂存队列。"""
        did = (q.get("device_id") or [""])[0]
        since = int((q.get("since") or ["0"])[0])
        if not did:
            raise ApiError(400, "device_id required")
        conn = get_db()
        try:
            rows = conn.execute(
                "SELECT seq,event_id,session_id,person_id,type,source,status,"
                "server_ts,note FROM events WHERE seq>? ORDER BY seq LIMIT 500",
                (since,)).fetchall()
            max_seq = conn.execute("SELECT COALESCE(MAX(seq),0) s FROM events").fetchone()["s"]
            last = rows[-1]["seq"] if rows else since
            conn.execute(
                "INSERT INTO devices(id,name,last_seq,last_sync_at) VALUES(?,?,?,?) "
                "ON CONFLICT(id) DO UPDATE SET last_seq=excluded.last_seq,"
                "last_sync_at=excluded.last_sync_at",
                (did, did, last, now_iso()))
            conn.commit()
            self._send_json(200, {"ok": True, "events": [dict(r) for r in rows],
                                  "cursor": last, "max_seq": max_seq})
        finally:
            conn.close()

    def _api_devices(self):
        conn = get_db()
        try:
            max_seq = conn.execute("SELECT COALESCE(MAX(seq),0) s FROM events").fetchone()["s"]
            rows = conn.execute("SELECT * FROM devices ORDER BY id").fetchall()
            out = []
            for r in rows:
                d = dict(r)
                d["lag"] = max_seq - r["last_seq"]
                out.append(d)
            self._send_json(200, {"ok": True, "devices": out, "max_seq": max_seq})
        finally:
            conn.close()

    # ---- 工作台：补签 / 撤销 / 确认 / 冲突 / 重算 ----
    def _api_supplement(self):
        """补签：管理员手工补录，独立 SUPPLEMENT 事件，直接计入确认人数。"""
        d = self._body()
        self._require(d, "session_id", "person_id")
        conn = get_db()
        try:
            conn.execute("BEGIN IMMEDIATE")
            conn.execute(
                "INSERT OR IGNORE INTO eligibility(session_id,person_id,created_at) "
                "VALUES(?,?,?)", (d["session_id"], d["person_id"], now_iso()))
            res = apply_event(conn, event_id=new_id(), session_id=d["session_id"],
                              person_id=d["person_id"], ev_type="SUPPLEMENT",
                              source="admin", device_id="workbench",
                              note=d.get("note", ""))
            counts = session_counts(conn, d["session_id"])
            conn.execute("COMMIT")
            self._send_json(200, {"ok": True, "result": res, "counts": counts})
        finally:
            conn.close()

    def _api_revoke(self):
        """撤销：独立 REVOKE 事件，不删除、不覆盖历史签到。"""
        d = self._body()
        self._require(d, "session_id", "person_id")
        conn = get_db()
        try:
            conn.execute("BEGIN IMMEDIATE")
            res = apply_event(conn, event_id=new_id(), session_id=d["session_id"],
                              person_id=d["person_id"], ev_type="REVOKE",
                              source="admin", device_id="workbench",
                              note=d.get("reason", ""))
            counts = session_counts(conn, d["session_id"])
            conn.execute("COMMIT")
            self._send_json(200, {"ok": True, "result": res, "counts": counts})
        finally:
            conn.close()

    def _api_confirm(self):
        """把某场次全部暂定签到确认为强一致结果：暂定 → 确认。"""
        d = self._body()
        self._require(d, "session_id")
        conn = get_db()
        try:
            conn.execute("BEGIN IMMEDIATE")
            n1 = conn.execute(
                "UPDATE events SET status='confirmed' WHERE session_id=? AND "
                "status='tentative'", (d["session_id"],)).rowcount
            n2 = conn.execute(
                "UPDATE checkin_state SET quality='confirmed' WHERE session_id=? AND "
                "state='valid' AND quality='tentative'", (d["session_id"],)).rowcount
            counts = session_counts(conn, d["session_id"])
            conn.execute("COMMIT")
            self._send_json(200, {"ok": True, "events_promoted": n1,
                                  "states_promoted": n2, "counts": counts})
        finally:
            conn.close()

    def _api_conflicts(self, q):
        sid = (q.get("session_id") or [None])[0]
        conn = get_db()
        try:
            sql = ("SELECT * FROM events WHERE status='conflict' AND resolution IS NULL")
            args = []
            if sid:
                sql += " AND session_id=?"
                args.append(sid)
            rows = conn.execute(sql + " ORDER BY seq DESC", args).fetchall()
            self._send_json(200, {"ok": True,
                                  "conflicts": [dict(r) for r in rows]})
        finally:
            conn.close()

    def _api_conflict_resolve(self):
        """冲突处置：accept → 该事件生效（再次入场）；reject → 驳回。随后自动重算。"""
        d = self._body()
        self._require(d, "event_id", "action")
        if d["action"] not in ("accept", "reject"):
            raise ApiError(400, "action must be accept|reject")
        conn = get_db()
        try:
            conn.execute("BEGIN IMMEDIATE")
            ev = conn.execute("SELECT * FROM events WHERE event_id=?",
                              (d["event_id"],)).fetchone()
            if not ev or ev["status"] != "conflict":
                raise ApiError(404, "conflict not found")
            if d["action"] == "accept":
                conn.execute("UPDATE events SET resolution='accepted', "
                             "status='confirmed' WHERE event_id=?", (d["event_id"],))
            else:
                conn.execute("UPDATE events SET resolution='rejected', "
                             "status='rejected' WHERE event_id=?", (d["event_id"],))
            report = recalculate(conn, ev["session_id"])
            conn.execute("COMMIT")
            self._send_json(200, {"ok": True, "recalculate": report})
        finally:
            conn.close()

    def _api_recalculate(self):
        d = self._body()
        self._require(d, "session_id")
        conn = get_db()
        try:
            conn.execute("BEGIN IMMEDIATE")
            report = recalculate(conn, d["session_id"])
            conn.execute("COMMIT")
            self._send_json(200, {"ok": True, "recalculate": report})
        finally:
            conn.close()

    # ---- 事件查询 ----
    def _api_events(self, q):
        sid = (q.get("session_id") or [None])[0]
        limit = min(int((q.get("limit") or ["200"])[0]), 1000)
        conn = get_db()
        try:
            if sid:
                rows = conn.execute(
                    "SELECT * FROM events WHERE session_id=? ORDER BY seq DESC LIMIT ?",
                    (sid, limit)).fetchall()
            else:
                rows = conn.execute(
                    "SELECT * FROM events ORDER BY seq DESC LIMIT ?",
                    (limit,)).fetchall()
            self._send_json(200, {"ok": True, "events": [dict(r) for r in rows]})
        finally:
            conn.close()

    # ---- 主视觉发布（版本化 + 原子生效）----
    def _api_visual_publish(self):
        d = self._body()
        self._require(d, "title")
        conn = get_db()
        try:
            conn.execute("BEGIN IMMEDIATE")
            sid = d.get("session_id") or None
            v = conn.execute("SELECT COALESCE(MAX(version),0)+1 v FROM visuals").fetchone()["v"]
            conn.execute("UPDATE visuals SET is_published=0 WHERE is_published=1 AND "
                         "COALESCE(session_id,'')=COALESCE(?, '')", (sid,))
            vid = new_id()
            conn.execute(
                "INSERT INTO visuals(id,session_id,title,image_url,bg_color,version,"
                "is_published,published_at) VALUES(?,?,?,?,?,?,1,?)",
                (vid, sid, d["title"], d.get("image_url"),
                 d.get("bg_color") or "#0b3d91", v, now_iso()))
            conn.execute("COMMIT")
            self._send_json(200, {"ok": True, "visual_id": vid, "version": v})
        finally:
            conn.close()


def main():
    global DB_PATH, SECRET
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default="checkin.db")
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--secret", default="dev-secret-change-me")
    ap.add_argument("--seed", action="store_true", help="写入演示数据")
    args = ap.parse_args()
    DB_PATH, SECRET = args.db, args.secret
    init_db()
    if args.seed:
        seed()
    srv = ThreadingHTTPServer(("0.0.0.0", args.port), Handler)
    print(f"server ready  db={DB_PATH}  port={args.port}")
    print(f"  大屏:   http://localhost:{args.port}/screen")
    print(f"  工作台: http://localhost:{args.port}/admin")
    srv.serve_forever()


def seed():
    conn = get_db()
    conn.execute("BEGIN IMMEDIATE")
    sid = new_id()
    conn.execute("INSERT INTO sessions(id,name,status,is_current,created_at) "
                 "VALUES(?,?, 'active', 1, ?)",
                 (sid, "秋季迎新晚会 · 第一场", now_iso()))
    ts = now_iso()
    for i in range(1, 51):
        conn.execute("INSERT OR IGNORE INTO eligibility VALUES(?,?,?)",
                     (sid, f"2026{i:04d}", ts))
    conn.execute("INSERT INTO visuals(id,session_id,title,image_url,bg_color,version,"
                 "is_published,published_at) VALUES(?,?,?,?,?,1,1,?)",
                 (new_id(), sid, "秋季迎新晚会", "", "#0b3d91", ts))
    conn.execute("COMMIT")
    conn.close()
    print(f"seeded session: {sid}  (资格名单 20260001..20260050)")


if __name__ == "__main__":
    main()
