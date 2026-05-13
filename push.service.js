/**
 * Web Push notification service for team-member PWA.
 *
 * Endpoints (all under /api/push when mounted):
 *   GET    /public-key             — returns VAPID public key (anyone)
 *   POST   /subscribe              — store/refresh a push subscription (team-member JWT)
 *   POST   /unsubscribe            — remove subscription by endpoint (team-member JWT)
 *   POST   /test                   — send a test push to caller's own subscriptions (team-member JWT)
 *
 * Internal:
 *   sendToTeamMembers(memberIds, payload)
 *     Called by job-notifications.service. payload: { title, body, data? }
 *
 * Required env vars:
 *   VAPID_PUBLIC_KEY
 *   VAPID_PRIVATE_KEY
 *   VAPID_SUBJECT (optional, defaults to mailto:info@spotless.homes)
 *
 * Generate VAPID keys once with:
 *   node -e "console.log(JSON.stringify(require('web-push').generateVAPIDKeys()))"
 */

const express = require('express');
const jwt = require('jsonwebtoken');

let webpush = null;
try { webpush = require('web-push'); } catch (_) {}

const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key';

module.exports = (supabase, logger) => {
  const log = logger || console;
  const router = express.Router();

  const VAPID_PUBLIC = process.env.VAPID_PUBLIC_KEY || '';
  const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY || '';
  const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:info@spotless.homes';

  let vapidConfigured = false;
  if (webpush && VAPID_PUBLIC && VAPID_PRIVATE) {
    try {
      webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);
      vapidConfigured = true;
      log.log('[Push] VAPID configured');
    } catch (e) {
      log.warn('[Push] VAPID configuration failed:', e.message);
    }
  } else if (!webpush) {
    log.warn('[Push] web-push package not installed');
  } else {
    log.warn('[Push] VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY env vars missing — push disabled');
  }

  // ── Auth: team-member JWT ───────────────────────────────────────────────
  function authenticateTeamMember(req, res, next) {
    const authHeader = req.headers['authorization'] || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'No token provided' });
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      if (decoded.type !== 'team_member' || !decoded.teamMemberId) {
        return res.status(403).json({ error: 'Team member access required' });
      }
      req.teamMember = decoded;
      next();
    } catch (e) {
      return res.status(401).json({ error: 'Invalid token' });
    }
  }

  // ── Routes ──────────────────────────────────────────────────────────────
  router.get('/public-key', (req, res) => {
    if (!VAPID_PUBLIC) return res.status(503).json({ error: 'Push not configured' });
    res.json({ publicKey: VAPID_PUBLIC });
  });

  router.post('/subscribe', authenticateTeamMember, async (req, res) => {
    try {
      const { subscription } = req.body || {};
      if (!subscription || !subscription.endpoint || !subscription.keys?.p256dh || !subscription.keys?.auth) {
        return res.status(400).json({ error: 'Invalid subscription payload' });
      }
      const teamMemberId = req.teamMember.teamMemberId;
      const userId = req.teamMember.userId;

      const row = {
        team_member_id: teamMemberId,
        user_id: userId,
        endpoint: subscription.endpoint,
        p256dh: subscription.keys.p256dh,
        auth: subscription.keys.auth,
        user_agent: (req.headers['user-agent'] || '').slice(0, 500),
        last_used_at: new Date().toISOString(),
      };

      // Upsert by endpoint — re-subscribing on the same device just refreshes timestamps.
      const { error } = await supabase
        .from('push_subscriptions')
        .upsert(row, { onConflict: 'endpoint' });

      if (error) {
        log.error('[Push] subscribe upsert error:', error.message);
        return res.status(500).json({ error: 'Failed to save subscription' });
      }

      res.json({ ok: true });
    } catch (e) {
      log.error('[Push] subscribe error:', e.message);
      res.status(500).json({ error: 'Failed to subscribe' });
    }
  });

  router.post('/unsubscribe', authenticateTeamMember, async (req, res) => {
    try {
      const { endpoint } = req.body || {};
      if (!endpoint) return res.status(400).json({ error: 'endpoint required' });
      const teamMemberId = req.teamMember.teamMemberId;

      const { error } = await supabase
        .from('push_subscriptions')
        .delete()
        .eq('endpoint', endpoint)
        .eq('team_member_id', teamMemberId);

      if (error) {
        log.error('[Push] unsubscribe error:', error.message);
        return res.status(500).json({ error: 'Failed to unsubscribe' });
      }
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: 'Failed to unsubscribe' });
    }
  });

  router.post('/test', authenticateTeamMember, async (req, res) => {
    try {
      if (!vapidConfigured) return res.status(503).json({ error: 'Push not configured' });
      const teamMemberId = req.teamMember.teamMemberId;
      const result = await sendToTeamMembers([teamMemberId], {
        title: 'Test notification',
        body: 'Push is working!',
        data: { type: 'test' },
      });
      res.json({ ok: true, ...result });
    } catch (e) {
      log.error('[Push] test error:', e.message);
      res.status(500).json({ error: 'Failed to send test' });
    }
  });

  // ── Internal: send to team members ──────────────────────────────────────
  async function sendToTeamMembers(memberIds, payload) {
    if (!vapidConfigured) {
      return { sent: 0, failed: 0, skipped: 'vapid_not_configured' };
    }
    const ids = (memberIds || []).map(Number).filter((n) => Number.isFinite(n) && n > 0);
    if (ids.length === 0) return { sent: 0, failed: 0 };

    const { data: subs, error } = await supabase
      .from('push_subscriptions')
      .select('id, endpoint, p256dh, auth, team_member_id')
      .in('team_member_id', ids);

    if (error) {
      log.warn('[Push] subscription lookup failed:', error.message);
      return { sent: 0, failed: 0, error: error.message };
    }
    if (!subs || subs.length === 0) return { sent: 0, failed: 0 };

    const notification = JSON.stringify({
      title: payload.title || 'ServiceFlow',
      body: payload.body || '',
      data: payload.data || {},
      icon: '/logo192.png',
      badge: '/logo192.png',
    });

    let sent = 0;
    let failed = 0;
    const expiredIds = [];

    await Promise.all(subs.map(async (s) => {
      try {
        await webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          notification,
        );
        sent++;
      } catch (err) {
        failed++;
        // 404/410 = subscription gone for good — clean up.
        if (err.statusCode === 404 || err.statusCode === 410) {
          expiredIds.push(s.id);
        } else {
          log.warn(`[Push] send failed (${err.statusCode || '?'}):`, err.body || err.message);
        }
      }
    }));

    if (expiredIds.length > 0) {
      await supabase.from('push_subscriptions').delete().in('id', expiredIds);
      log.log(`[Push] Cleaned up ${expiredIds.length} expired subscriptions`);
    }

    return { sent, failed };
  }

  // Expose as router properties (mirrors notification-email pattern).
  router.sendToTeamMembers = sendToTeamMembers;

  return router;
};
