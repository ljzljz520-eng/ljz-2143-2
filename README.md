# 校园活动签到系统

C 端大屏（主视觉 + 人数）· Web 工作台（场次 / 签到撤销 / 冲突处置）· 服务端
（参与资格、签到事件、设备同步进度持久化）。**仅依赖 Python 3 标准库 + SQLite**。

## 运行

```bash
python3 server.py --db checkin.db --port 8000 --secret <生产密钥> --seed
# 大屏   http://localhost:8000/screen
# 工作台 http://localhost:8000/admin
python3 tests/acceptance.py     # 32 项验收测试
```

## 计数策略：比较与选型

| 维度 | 在线强一致计数 | 离线暂存后合并 |
|---|---|---|
| 一致性 | 单事务串行化，同场同人只落一个有效签到 | 合并时才能发现冲突，需事后处置 |
| 可用性 | 断网即停摆 | 断网可继续扫码，恢复后批量上报 |
| 人数语义 | 直接计入「确认人数」 | 先计入「暂定人数」，确认后转正 |
| 冲突 | 无（并发由状态表主键+写事务裁决） | 迟到/换场/重复需冲突区人工处置 |

**选型：混合策略** —— 在线时走强一致（默认路径）；断网时凭签名票据离线暂存、
联网后合并为「暂定」，由工作台确认或处置冲突后转入「确认」。
大屏把 **确认人数** 与 **暂定人数**（= 确认 + 待确认）分开展示，互不混算。

## 关键设计

- **事件溯源**：`CHECKIN / SUPPLEMENT(补签) / REENTRY(再次入场) / REVOKE(撤销)`
  全部是独立追加事件（`events` 表），`checkin_state` 只是事件流的物化视图，
  可随时「重算」重建 —— 绝不只覆盖布尔字段。
- **幂等**：终端生成 `event_id`，服务端唯一约束去重；“服务器成功而终端重试”
  返回首次结果，不重复计数。两台设备同时扫同一人：写事务串行化 +
  `(session_id, person_id)` 主键，一先一后，后者记 `duplicate`。
- **离线票据**：`CK1.<场次>.<学号>.<iat>.<exp>.<nonce>.<HMAC>`，绑定场次与有效
  时间窗（按扫码时刻校验）。换场即封旧场，旧队列合并只进原场次的冲突区
  （`SESSION_CLOSED`），**绝不进入新场次人数**。
- **原子换场**：封旧场、开新场、记 `SESSION_SWITCH` 事件在同一写事务；
  大屏在**同一读事务**取出当前场次 + 人数 + 主视觉版本，切换无中间态。
- **设备同步**：事件 `seq` 全局单调，设备按游标拉取；`SESSION_SWITCH` 事件
  提示设备清空本地旧场次暂存队列；`devices.last_seq/lag` 持久化同步进度。
- **隐私与降级**：大屏接口不下发任何个人信息，只显示场次名与两个数字；
  主视觉图片损坏时 `onerror` 降级为渐变背景 + 标题，签到链路完全独立、
  保持可操作；横竖屏旋转仅触发 CSS 重排，状态不丢失。

## 验收场景 → 测试映射（tests/acceptance.py，32 项全过）

| 验收要求 | 场景 |
|---|---|
| 两台设备同时扫同一人 | 场景1：1 confirmed + 1 duplicate，人数=1 |
| 服务器成功而终端重试 | 场景2：幂等返回，事件表不增、人数不变 |
| 撤销后旧签到迟到 | 场景3：进冲突区 → 接受为再次入场 → 重算幂等 |
| 撤销/再次入场独立事件 | 场景4：CHECKIN→REVOKE→REENTRY 三段可溯 |
| 换场后旧队列不进新人数 | 场景5：SESSION_CLOSED 冲突，新场人数=0 |
| 人数与场次原子切换 | 场景5：大屏一次读取同时切到新场次与其人数 |
| 暂定/确认分开展示 | 场景6：离线合并进暂定，确认后转正；补签直接确认 |
| 参与资格持久化 | 场景7：无资格拒绝且不计数 |
| 设备同步进度 | 场景8：游标推进、lag=0、含 SESSION_SWITCH |
| 发布主视觉（含旋转） | 场景9：版本化原子发布；旋转由大屏 CSS 自适应 |

## API 摘要

```
GET  /api/screen/state            大屏原子状态（场次+双人数+主视觉版本）
POST /api/sessions                建场次   POST /api/sessions/{id}/activate|close
POST /api/sessions/{id}/eligibility  导入参与资格
POST /api/tickets                 签发离线票据（绑定场次+有效窗）
POST /api/checkin                 在线签到（强一致，幂等）
POST /api/sync/merge              离线暂存批量合并（进暂定/冲突）
POST /api/admin/supplement|revoke|confirm   补签 / 撤销 / 暂定转正
GET  /api/admin/conflicts         冲突列表
POST /api/admin/conflicts/resolve 冲突处置（自动重算）
POST /api/admin/recalculate       按事件流重算人数
POST /api/devices/register        注册设备
GET  /api/sync/events?device_id&since  设备拉取事件流（推进同步游标）
GET  /api/devices                 设备同步进度
POST /api/visuals/publish         发布主视觉（版本化原子生效）
```
