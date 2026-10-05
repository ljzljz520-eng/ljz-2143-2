#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""验收测试：并发扫码 / 撤销后迟到 / 终端重试 / 换场隔离 / 双人数 / 同步进度 / 主视觉"""
import json, socket, subprocess, sys, tempfile, threading, time, os
import urllib.request
from datetime import datetime, timezone

def iso_now(offset=0.0):
    return datetime.fromtimestamp(time.time() + offset, timezone.utc).isoformat(
        timespec="milliseconds")

PY = sys.executable
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

def free_port():
    s = socket.socket(); s.bind(("127.0.0.1", 0)); p = s.getsockname()[1]
    s.close(); return p

PORT = free_port()
BASE = f"http://127.0.0.1:{PORT}"
PASSED, FAILED = [], []

def req(path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(BASE + path, data=data,
                               headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(r) as resp:
        return json.loads(resp.read().decode())

def check(name, cond, detail=""):
    (PASSED if cond else FAILED).append(name)
    print(f"  [{'PASS' if cond else 'FAIL'}] {name}" + (f"  -- {detail}" if detail and not cond else ""))

def new_session(name, persons):
    sid = req("/api/sessions", {"name": name})["session_id"]
    req(f"/api/sessions/{sid}/eligibility", {"person_ids": persons})
    req(f"/api/sessions/{sid}/activate", {})
    return sid

def ticket(sid, pid, secs=3600):
    return req("/api/tickets", {"session_id": sid, "person_id": pid,
                                "valid_seconds": secs})["ticket"]

def counts(sid):
    for s in req("/api/sessions")["sessions"]:
        if s["id"] == sid:
            return s["counts"]
    raise AssertionError("session missing")

def events(sid):
    return req(f"/api/events?session_id={sid}&limit=500")["events"]

def scenario_concurrent():
    print("\n[场景1] 两台设备同时扫同一人 → 只形成一个有效签到")
    sid = new_session("并发场", ["P001"])
    tk = ticket(sid, "P001")
    results, barrier = [], threading.Barrier(2)
    def scan(dev):
        barrier.wait()
        results.append(req("/api/checkin", {"event_id": os.urandom(16).hex(),
            "device_id": dev, "ticket": tk, "client_ts": "2026-10-05T10:00:00+00:00"}))
    ts = [threading.Thread(target=scan, args=(f"dev-{i}",)) for i in (1, 2)]
    [t.start() for t in ts]; [t.join() for t in ts]
    statuses = sorted(r["result"]["status"] for r in results)
    c = counts(sid)
    check("一设备 confirmed、另一设备 duplicate", statuses == ["confirmed", "duplicate"], str(statuses))
    check("确认人数恰好为 1", c["confirmed"] == 1 and c["tentative_total"] == 1, str(c))

def scenario_retry():
    print("\n[场景2] 服务器成功而终端重试 → 幂等，不重复计数")
    sid = new_session("重试场", ["P002"])
    tk = ticket(sid, "P002")
    eid = os.urandom(16).hex()
    r1 = req("/api/checkin", {"event_id": eid, "device_id": "dev-R", "ticket": tk})
    n1 = len(events(sid))
    r2 = req("/api/checkin", {"event_id": eid, "device_id": "dev-R", "ticket": tk})
    n2 = len(events(sid))
    c = counts(sid)
    check("首次 confirmed", r1["result"]["status"] == "confirmed")
    check("重试返回幂等结果", r2["result"].get("idempotent") is True, str(r2))
    check("事件表未新增记录", n1 == n2, f"{n1} vs {n2}")
    check("人数仍为 1", c["confirmed"] == 1, str(c))

def scenario_late_after_revoke():
    print("\n[场景3] 撤销后旧签到迟到 → 进冲突区；处置后重算")
    sid = new_session("撤销场", ["P003"])
    tk = ticket(sid, "P003")
    req("/api/checkin", {"event_id": os.urandom(16).hex(), "device_id": "dev-1",
                         "ticket": tk, "client_ts": iso_now()})
    scan_ts = iso_now()          # 离线扫码发生在撤销“之前”
    time.sleep(0.05)
    req("/api/admin/revoke", {"session_id": sid, "person_id": "P003"})
    c = counts(sid)
    check("撤销后人数为 0", c["confirmed"] == 0 and c["revoked"] == 1, str(c))
    # 离线设备在撤销“之前”扫的票，撤销“之后”才合并上来
    late = req("/api/sync/merge", {"device_id": "dev-off", "events": [
        {"event_id": os.urandom(16).hex(), "ticket": tk,
         "client_ts": scan_ts}]})["results"][0]
    check("迟到旧签到进入冲突区", late["status"] == "conflict"
          and late["note"] == "LATE_AFTER_REVOKE", str(late))
    c = counts(sid)
    check("冲突未自动计入人数", c["tentative_total"] == 0, str(c))
    cfs = req("/api/admin/conflicts?session_id=" + sid)["conflicts"]
    check("工作台可见待处置冲突", len(cfs) == 1)
    rep = req("/api/admin/conflicts/resolve",
              {"event_id": cfs[0]["event_id"], "action": "accept"})["recalculate"]
    c = counts(sid)
    check("接受为再次入场后人数为 1", c["confirmed"] == 1, str(c))
    check("重算报告含校正记录", len(rep["corrections"]) >= 1, str(rep))
    rep2 = req("/api/admin/recalculate", {"session_id": sid})["recalculate"]
    check("再次重算幂等（无新校正）", len(rep2["corrections"]) == 0, str(rep2))

def scenario_reentry():
    print("\n[场景4] 撤销 → 再次入场：独立 REENTRY 事件")
    sid = new_session("再入场", ["P004"])
    tk = ticket(sid, "P004")
    req("/api/checkin", {"event_id": os.urandom(16).hex(), "device_id": "d", "ticket": tk})
    req("/api/admin/revoke", {"session_id": sid, "person_id": "P004"})
    r = req("/api/checkin", {"event_id": os.urandom(16).hex(), "device_id": "d", "ticket": tk})
    types = [e["type"] for e in reversed(events(sid)) if e["person_id"] == "P004"]
    c = counts(sid)
    check("再次扫码记为 REENTRY", r["result"]["type"] == "REENTRY", str(r))
    check("事件流含 CHECKIN→REVOKE→REENTRY 三段独立事件",
          types == ["CHECKIN", "REVOKE", "REENTRY"], str(types))
    check("人数恢复为 1", c["confirmed"] == 1, str(c))

def scenario_session_switch():
    print("\n[场景5] 换场后旧扫描队列不得进入新人数（原子切换）")
    sA = new_session("第一场", ["P005"])
    tkA = ticket(sA, "P005")
    staged = {"event_id": os.urandom(16).hex(), "ticket": tkA,
              "client_ts": iso_now()}                    # 设备离线暂存
    sB = new_session("第二场", ["P006"])                    # 原子换场 → A 自动封场
    res = req("/api/sync/merge", {"device_id": "dev-off2", "events": [staged]})["results"][0]
    check("旧队列合并结果为冲突(SESSION_CLOSED)", res["status"] == "conflict"
          and res["note"] == "SESSION_CLOSED", str(res))
    check("新场人数未被污染", counts(sB)["tentative_total"] == 0, str(counts(sB)))
    check("旧场人数也未计入", counts(sA)["tentative_total"] == 0, str(counts(sA)))
    st = req("/api/screen/state")
    check("大屏原子呈现新场次与其人数", st["session"]["id"] == sB
          and st["counts"]["tentative_total"] == 0, json.dumps(st["session"]))
    # 过期票据直接拒绝
    tk_exp = req("/api/tickets", {"session_id": sB, "person_id": "P006",
                                  "valid_seconds": 1})
    time.sleep(1.2)
    try:
        req("/api/checkin", {"event_id": os.urandom(16).hex(), "device_id": "d",
                             "ticket": tk_exp["ticket"]})
        check("过期票据返回错误", False)
    except urllib.error.HTTPError as e:
        check("过期票据返回错误", e.code == 403, str(e.code))

def scenario_tentative_confirmed():
    print("\n[场景6] 暂定人数与确认人数分开展示，确认后转移")
    sid = new_session("双人数场", ["P007", "P008", "P009"])
    req("/api/checkin", {"event_id": os.urandom(16).hex(), "device_id": "d",
                         "ticket": ticket(sid, "P007")})          # 在线 → 确认
    req("/api/sync/merge", {"device_id": "dev-off3", "events": [
        {"event_id": os.urandom(16).hex(), "ticket": ticket(sid, "P008"),
         "client_ts": iso_now()}]})              # 离线 → 暂定
    st = req("/api/screen/state")
    check("大屏分别返回确认/暂定", st["counts"]["confirmed"] == 1
          and st["counts"]["tentative_pending"] == 1
          and st["counts"]["tentative_total"] == 2, json.dumps(st["counts"]))
    req("/api/admin/confirm", {"session_id": sid})
    c = counts(sid)
    check("确认后 确认=2 待确认=0", c["confirmed"] == 2 and c["tentative_pending"] == 0, str(c))
    # 补签直接计入确认
    req("/api/admin/supplement", {"session_id": sid, "person_id": "P009"})
    c = counts(sid)
    check("补签计入确认人数", c["confirmed"] == 3, str(c))
    types = [e["type"] for e in events(sid)]
    check("补签为独立 SUPPLEMENT 事件", "SUPPLEMENT" in types, str(types))

def scenario_eligibility():
    print("\n[场景7] 无资格者扫码被拒，不计入人数")
    sid = new_session("资格场", ["P010"])
    r = req("/api/checkin", {"event_id": os.urandom(16).hex(), "device_id": "d",
                             "session_id": sid, "person_id": "P999"})
    check("NOT_ELIGIBLE 拒绝", r["result"]["status"] == "rejected"
          and r["result"]["note"] == "NOT_ELIGIBLE", str(r))
    check("人数仍为 0", counts(sid)["tentative_total"] == 0)

def scenario_devices():
    print("\n[场景8] 设备同步进度持久化")
    did = "dev-sync-1"
    req("/api/devices/register", {"device_id": did, "name": "南门闸机"})
    feed = req(f"/api/sync/events?device_id={did}&since=0")
    check("设备拉到事件流且游标推进", feed["cursor"] > 0 and feed["max_seq"] >= feed["cursor"])
    check("事件流包含 SESSION_SWITCH（供设备清空旧队列）",
          any(e["type"] == "SESSION_SWITCH" for e in feed["events"]))
    devs = {d["id"]: d for d in req("/api/devices")["devices"]}
    check("服务端记录 last_seq 且 lag=0", devs[did]["last_seq"] == feed["cursor"]
          and devs[did]["lag"] == 0, json.dumps(devs.get(did)))

def scenario_visual():
    print("\n[场景9] 主视觉版本化原子发布")
    sid = req("/api/screen/state")["session"]["id"]
    req("/api/visuals/publish", {"title": "全局视觉", "image_url": "", "bg_color": "#111111"})
    v2 = req("/api/visuals/publish", {"session_id": sid, "title": "专场视觉",
                                      "image_url": "https://example.invalid/kv.png",
                                      "bg_color": "#222222"})["version"]
    st = req("/api/screen/state")
    check("大屏原子切换到最新发布版本", st["visual"]["version"] == v2
          and st["visual"]["title"] == "专场视觉", json.dumps(st["visual"]))
    check("场次与人数仍一致（发布不影响签到）", st["session"]["id"] == sid)

def main():
    tmp = tempfile.mkdtemp(prefix="cktest_")
    proc = subprocess.Popen([PY, os.path.join(ROOT, "server.py"),
                             "--db", os.path.join(tmp, "t.db"),
                             "--port", str(PORT), "--secret", "test-secret"],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        for _ in range(60):
            try:
                req("/api/sessions"); break
            except Exception:
                time.sleep(0.2)
        else:
            print("server failed to start"); sys.exit(1)
        scenario_concurrent(); scenario_retry(); scenario_late_after_revoke()
        scenario_reentry(); scenario_session_switch(); scenario_tentative_confirmed()
        scenario_eligibility(); scenario_devices(); scenario_visual()
    finally:
        proc.terminate(); proc.wait(timeout=5)
    print(f"\n===== 结果: {len(PASSED)} 通过, {len(FAILED)} 失败 =====")
    if FAILED:
        print("失败项:", *FAILED, sep="\n  - "); sys.exit(1)

if __name__ == "__main__":
    main()
