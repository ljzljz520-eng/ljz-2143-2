import { createHmac, timingSafeEqual } from 'node:crypto';

const SECRET = process.env.TICKET_SECRET || 'dev-campus-checkin-secret-change-me';
const DEFAULT_TTL_MS = 12 * 60 * 60 * 1000;

export function issueTicket({ activityId, sessionId, personId, issuedAtIso, expiresAtIso, ticketId }) {
  const issuedAt = issuedAtIso || new Date().toISOString();
  const expiresAt = expiresAtIso || new Date(Date.now() + DEFAULT_TTL_MS).toISOString();
  const payload = {
    v: 1,
    tid: ticketId,
    aid: activityId,
    sid: sessionId,
    pid: personId,
    iat: issuedAt,
    exp: expiresAt
  };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = createHmac('sha256', SECRET).update(body).digest('base64url');
  return { ...payload, token: `${body}.${sig}` };
}

export function verifyTicket(token, nowMs = Date.now()) {
  if (typeof token !== 'string' || !token.includes('.')) {
    return { ok: false, code: 'ticket_malformed' };
  }
  const [body, sig] = token.split('.');
  const expected = createHmac('sha256', SECRET).update(body).digest('base64url');
  let sigBuffer;
  let expectedBuffer;
  try {
    sigBuffer = Buffer.from(sig || '', 'base64url');
    expectedBuffer = Buffer.from(expected, 'base64url');
  } catch {
    return { ok: false, code: 'ticket_malformed' };
  }
  if (sigBuffer.length !== expectedBuffer.length || !timingSafeEqual(sigBuffer, expectedBuffer)) {
    return { ok: false, code: 'ticket_bad_signature' };
  }
  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, code: 'ticket_malformed' };
  }
  if (!payload.aid || !payload.sid || !payload.pid || !payload.tid) {
    return { ok: false, code: 'ticket_missing_scope' };
  }
  if (Date.parse(payload.exp) < nowMs) return { ok: false, code: 'ticket_expired', payload };
  if (Date.parse(payload.iat) > nowMs + 60_000) return { ok: false, code: 'ticket_future', payload };
  return { ok: true, payload };
}

export function checkTicketScope(payload, activityId, sessionId, nowMs = Date.now()) {
  if (payload.aid !== activityId || payload.sid !== sessionId) {
    return { ok: false, code: 'ticket_wrong_session' };
  }
  if (Date.parse(payload.exp) < nowMs) return { ok: false, code: 'ticket_expired' };
  return { ok: true };
}
