/**
 * Job notification service — emails team members on assignment, reschedule, cancel.
 * Web push is added in a sibling module and called in parallel from the same hooks.
 *
 * Usage:
 *   const jobNotifications = require('./job-notifications.service')(supabase, logger, notificationEmail, pushService)
 *   await jobNotifications.notifyAssigned(userId, jobId, [memberId1, memberId2])
 *   await jobNotifications.notifyRescheduled(userId, jobId, memberIds, { oldDate, oldTime, newDate, newTime })
 *   await jobNotifications.notifyCanceled(userId, jobId, memberIds, { reason })
 *
 * All public methods are fire-and-forget safe: errors are logged but never thrown.
 */

module.exports = (supabase, logger, notificationEmail, pushService) => {
  const log = logger || console

  function fmtDateTime(scheduledDate, scheduledTime) {
    if (!scheduledDate) return 'Date TBD'
    const datePart = String(scheduledDate).split(/[ T]/)[0]
    const m = datePart.match(/^(\d{4})-(\d{2})-(\d{2})$/)
    if (!m) return datePart
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
    const dateLabel = d.toLocaleDateString('en-US', {
      weekday: 'long', month: 'short', day: 'numeric', year: 'numeric',
    })
    if (!scheduledTime) return dateLabel
    const tm = String(scheduledTime).match(/^(\d{2}):(\d{2})/)
    if (!tm) return `${dateLabel} at ${scheduledTime}`
    let hh = Number(tm[1])
    const mm = tm[2]
    const ampm = hh >= 12 ? 'PM' : 'AM'
    hh = hh % 12 || 12
    return `${dateLabel} at ${hh}:${mm} ${ampm}`
  }

  async function getJobContext(jobId) {
    const { data, error } = await supabase
      .from('jobs')
      .select(`
        id, user_id, status,
        scheduled_date, scheduled_time, duration,
        service_name, service_address_street, service_address_city,
        service_address_state, service_address_zip,
        customers!left(first_name, last_name)
      `)
      .eq('id', jobId)
      .maybeSingle()
    if (error || !data) {
      log.warn(`[JobNotifications] job ${jobId} not found:`, error?.message)
      return null
    }
    const addr = [
      data.service_address_street,
      data.service_address_city,
      data.service_address_state,
      data.service_address_zip,
    ].filter(Boolean).join(', ')
    const customerName = data.customers
      ? [data.customers.first_name, data.customers.last_name].filter(Boolean).join(' ').trim()
      : ''
    return {
      jobId: data.id,
      userId: data.user_id,
      status: data.status,
      scheduledDate: data.scheduled_date,
      scheduledTime: data.scheduled_time,
      duration: data.duration,
      serviceName: data.service_name || 'Service',
      address: addr,
      customerName,
      displayWhen: fmtDateTime(data.scheduled_date, data.scheduled_time),
    }
  }

  async function getTeamMembers(teamMemberIds) {
    const ids = (teamMemberIds || []).map(Number).filter((n) => Number.isFinite(n) && n > 0)
    if (ids.length === 0) return []
    const { data, error } = await supabase
      .from('team_members')
      .select('id, email, first_name, last_name')
      .in('id', ids)
    if (error) {
      log.warn('[JobNotifications] team_members lookup failed:', error.message)
      return []
    }
    return (data || []).filter((m) => m.email)
  }

  function jobDetailUrl() {
    const base = process.env.FRONTEND_URL || 'https://service-flow.pro'
    return `${base}/#/team-member/field-app`
  }

  function wrap(bodyHtml) {
    return `<div style="font-family: -apple-system, Segoe UI, Roboto, Arial, sans-serif; max-width: 600px; margin: 0 auto; color: #1A1D26;">${bodyHtml}<p style="color: #6b7280; font-size: 12px; margin-top: 32px;">Sent by ServiceFlow</p></div>`
  }

  function jobDetailsBlock(ctx) {
    const rows = [
      ['Service', ctx.serviceName],
      ['When', ctx.displayWhen],
      ctx.customerName ? ['Customer', ctx.customerName] : null,
      ctx.address ? ['Address', ctx.address] : null,
    ].filter(Boolean)
    return `
      <table style="width: 100%; border-collapse: collapse; margin: 16px 0; background: #f5f7fa; border-radius: 8px;">
        ${rows.map(([k, v]) => `
          <tr>
            <td style="padding: 10px 14px; color: #6b7280; font-size: 13px; width: 100px;">${k}</td>
            <td style="padding: 10px 14px; font-weight: 500;">${escapeHtml(v)}</td>
          </tr>
        `).join('')}
      </table>
    `
  }

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]))
  }

  function ctaButton(label, url, color = '#1976F2') {
    return `<div style="text-align: center; margin: 24px 0;">
      <a href="${url}" style="background:${color}; color:#fff; padding:12px 24px; text-decoration:none; border-radius:8px; display:inline-block; font-weight:600;">${label}</a>
    </div>`
  }

  // ── Public ───────────────────────────────────────────────────────────────

  async function notifyAssigned(userId, jobId, teamMemberIds) {
    try {
      if (!userId || !jobId || !teamMemberIds || teamMemberIds.length === 0) return
      const ctx = await getJobContext(jobId)
      if (!ctx) return
      const members = await getTeamMembers(teamMemberIds)
      if (members.length === 0) return

      const subject = `New job assigned — ${ctx.serviceName} on ${ctx.displayWhen}`
      const url = jobDetailUrl()

      for (const m of members) {
        const greeting = m.first_name ? `Hi ${m.first_name},` : 'Hi,'
        const html = wrap(`
          <h2 style="color:#1976F2; margin: 0 0 12px;">You've been assigned to a job</h2>
          <p>${greeting}</p>
          <p>A new job has been assigned to you.</p>
          ${jobDetailsBlock(ctx)}
          ${ctaButton('Open job', url)}
        `)
        const text = `${greeting}\n\nYou've been assigned to a new job.\n\n${ctx.serviceName}\n${ctx.displayWhen}\n${ctx.customerName}\n${ctx.address}\n\nOpen: ${url}`

        try {
          await notificationEmail.sendInternalEmail(userId, {
            to: m.email,
            toName: [m.first_name, m.last_name].filter(Boolean).join(' '),
            subject, html, text,
            emailType: 'job_assigned',
          })
        } catch (e) {
          log.warn(`[JobNotifications] assigned email failed for ${m.email}:`, e.message)
        }
      }

      if (pushService?.sendToTeamMembers) {
        await pushService.sendToTeamMembers(teamMemberIds, {
          title: 'New job assigned',
          body: `${ctx.serviceName} — ${ctx.displayWhen}`,
          data: { jobId: ctx.jobId, type: 'job_assigned' },
        })
      }
    } catch (e) {
      log.error('[JobNotifications] notifyAssigned error:', e.message)
    }
  }

  async function notifyRescheduled(userId, jobId, teamMemberIds, { oldDate, oldTime, newDate, newTime }) {
    try {
      if (!userId || !jobId || !teamMemberIds || teamMemberIds.length === 0) return
      const ctx = await getJobContext(jobId)
      if (!ctx) return
      const members = await getTeamMembers(teamMemberIds)
      if (members.length === 0) return

      const oldWhen = fmtDateTime(oldDate, oldTime)
      const newWhen = fmtDateTime(newDate, newTime)
      const subject = `Job rescheduled — ${ctx.serviceName}`
      const url = jobDetailUrl()

      for (const m of members) {
        const greeting = m.first_name ? `Hi ${m.first_name},` : 'Hi,'
        const html = wrap(`
          <h2 style="color:#F59E0B; margin: 0 0 12px;">A job you're assigned to has been rescheduled</h2>
          <p>${greeting}</p>
          <table style="width:100%; border-collapse:collapse; margin: 12px 0;">
            <tr>
              <td style="padding:8px 12px; background:#fef3c7; color:#92400e; border-radius:6px 0 0 6px;">Previously</td>
              <td style="padding:8px 12px; background:#fef3c7; color:#92400e; border-radius:0 6px 6px 0; text-decoration:line-through;">${escapeHtml(oldWhen)}</td>
            </tr>
            <tr><td style="height:8px"></td><td></td></tr>
            <tr>
              <td style="padding:8px 12px; background:#dbeafe; color:#1e3a8a; border-radius:6px 0 0 6px;">Now</td>
              <td style="padding:8px 12px; background:#dbeafe; color:#1e3a8a; border-radius:0 6px 6px 0; font-weight:600;">${escapeHtml(newWhen)}</td>
            </tr>
          </table>
          ${jobDetailsBlock({ ...ctx, displayWhen: newWhen })}
          ${ctaButton('Open job', url)}
        `)
        const text = `${greeting}\n\nA job you're assigned to has been rescheduled.\n\nPreviously: ${oldWhen}\nNow: ${newWhen}\n\n${ctx.serviceName}\n${ctx.customerName}\n${ctx.address}\n\nOpen: ${url}`

        try {
          await notificationEmail.sendInternalEmail(userId, {
            to: m.email,
            toName: [m.first_name, m.last_name].filter(Boolean).join(' '),
            subject, html, text,
            emailType: 'job_rescheduled',
          })
        } catch (e) {
          log.warn(`[JobNotifications] rescheduled email failed for ${m.email}:`, e.message)
        }
      }

      if (pushService?.sendToTeamMembers) {
        await pushService.sendToTeamMembers(teamMemberIds, {
          title: 'Job rescheduled',
          body: `${ctx.serviceName} — now ${newWhen}`,
          data: { jobId: ctx.jobId, type: 'job_rescheduled' },
        })
      }
    } catch (e) {
      log.error('[JobNotifications] notifyRescheduled error:', e.message)
    }
  }

  async function notifyCanceled(userId, jobId, teamMemberIds, { reason } = {}) {
    try {
      if (!userId || !jobId || !teamMemberIds || teamMemberIds.length === 0) return
      const ctx = await getJobContext(jobId)
      if (!ctx) return
      const members = await getTeamMembers(teamMemberIds)
      if (members.length === 0) return

      const subject = `Job canceled — ${ctx.serviceName} on ${ctx.displayWhen}`

      for (const m of members) {
        const greeting = m.first_name ? `Hi ${m.first_name},` : 'Hi,'
        const reasonBlock = reason
          ? `<p style="background:#fee2e2; color:#991b1b; padding:10px 14px; border-radius:6px;"><strong>Reason:</strong> ${escapeHtml(reason)}</p>`
          : ''
        const html = wrap(`
          <h2 style="color:#DC2626; margin: 0 0 12px;">A job has been canceled</h2>
          <p>${greeting}</p>
          <p>The following job has been canceled. You no longer need to show up.</p>
          ${jobDetailsBlock(ctx)}
          ${reasonBlock}
        `)
        const text = `${greeting}\n\nA job has been canceled.\n\n${ctx.serviceName}\n${ctx.displayWhen}\n${ctx.customerName}\n${ctx.address}${reason ? `\nReason: ${reason}` : ''}\n\nYou no longer need to show up.`

        try {
          await notificationEmail.sendInternalEmail(userId, {
            to: m.email,
            toName: [m.first_name, m.last_name].filter(Boolean).join(' '),
            subject, html, text,
            emailType: 'job_canceled',
          })
        } catch (e) {
          log.warn(`[JobNotifications] canceled email failed for ${m.email}:`, e.message)
        }
      }

      if (pushService?.sendToTeamMembers) {
        await pushService.sendToTeamMembers(teamMemberIds, {
          title: 'Job canceled',
          body: `${ctx.serviceName} — ${ctx.displayWhen}`,
          data: { jobId: ctx.jobId, type: 'job_canceled' },
        })
      }
    } catch (e) {
      log.error('[JobNotifications] notifyCanceled error:', e.message)
    }
  }

  async function getAssignedMemberIds(jobId) {
    try {
      const { data } = await supabase
        .from('job_team_assignments')
        .select('team_member_id')
        .eq('job_id', jobId)
      return (data || []).map((r) => r.team_member_id).filter(Boolean)
    } catch (e) {
      return []
    }
  }

  return {
    notifyAssigned,
    notifyRescheduled,
    notifyCanceled,
    getAssignedMemberIds,
  }
}
