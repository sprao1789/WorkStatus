/**
 * WorkStatus — CRM Monthly Stats (Per-User Team Dashboard)
 * Catalyst Advanced IO Function using Express.js (Node.js 18)
 *
 * Confirmed Bugs module fields: id, Name, Status, Severity, Description, Owner, Created_By, Created_Time, Modified_Time
 * Confirmed Bug Status values: Open, In progress, To be tested, Fixed, Fixed by other checkins,
 *   Fixed By DB update, Closed, Closed - Not reproducible, Closed - Not an issue,
 *   Not an Issue, Not Reproducible, Duplicate Issue, Dependency Service Fixed
 *
 * Routes:
 *   GET /server/crm-monthly-stats/              → JSON stats
 *   GET /server/crm-monthly-stats/widget        → HTML dashboard (clickable members)
 *   GET /server/crm-monthly-stats/detail        → drill-down detail for one user
 *   GET /server/crm-monthly-stats/healthz       → { ok: true }
 *   GET /server/crm-monthly-stats/debug/*       → debug endpoints
 *
 * COQL QUIRKS:
 *   1. count(id) not supported → use paginated SELECT id
 *   2. SELECT without WHERE → SYNTAX_ERROR
 *   3. != on strings → empty body → use 'not in'
 *   4. +05:30 timezone → empty body → use UTC Z format
 *   5. >= AND <= on datetime → SYNTAX_ERROR → use BETWEEN
 */

'use strict';

const express  = require('express');
const https    = require('https');
const catalyst = require('zcatalyst-sdk-node');

const app = express();
app.use(express.json());

// ─── Config ───────────────────────────────────────────────────────────────────
const BUGS_MODULE = 'Bugs';
const PAGE_SIZE   = 200;

// ── All statuses confirmed from live data ─────────────────────────────────────
// ACTIVE (open/in-progress) statuses
const ACTIVE_STATUSES = [
  'Open', 'In progress', 'To be tested', 'Reopen',
  'Need to fix in automation', 'To be tested - Not an Issue',
  'Product flow change', 'Dependency Service Fixed'
];
// CLOSED / RESOLVED statuses
const CLOSED_STATUSES = [
  'Fixed', 'Fixed by other checkins', 'Fixed By DB update',
  'Closed', 'Closed - Not reproducible', 'Closed - Not an issue',
  'Closed - Wrong interpretation of test case',
  'Not an Issue', 'Not Reproducible', 'Not Resolved',
  'Duplicate Issue', 'Wrong interpretation of testcase',
  'fixed in automation', 'Reverted'
];
// Severity values in this org: MustFix, Show stopper (not standard Critical/Major/Minor)
// OPEN_STATUSES kept for backward compat
const OPEN_STATUSES = ACTIVE_STATUSES;

app.use((req, _res, next) => {
  const prefix = '/server/crm-monthly-stats';
  if (req.url.startsWith(prefix)) req.url = req.url.slice(prefix.length) || '/';
  next();
});

// ─── Team Members ─────────────────────────────────────────────────────────────
const TEAM = [
  { email: 'paparao.s@zohocorp.com',         name: 'Paparao S' },
  { email: 'muthu.p@zohocorp.com',            name: 'Muthu P' },
  { email: 'naveenkarthick.s@zohocorp.com',   name: 'Naveenkarthick S' },
  { email: 'vishwa.sr@zohocorp.com',          name: 'Vishwa SR' },
  { email: 'harish.subramanian@zohocorp.com', name: 'Harish Subramanian' }
];

// ─── HTTP helpers ─────────────────────────────────────────────────────────────
function crmGet(authHeader, path) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname:'www.zohoapis.in', path, method:'GET', headers:{'Authorization':authHeader} }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(new Error(`JSON parse error: ${data.substring(0,200)}`)); } });
    });
    req.on('error', reject);
    req.end();
  });
}

function crmPost(authHeader, path, body) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify(body);
    const req = https.request({
      hostname: 'www.zohoapis.in', path, method: 'POST',
      headers: { 'Authorization': authHeader, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) }
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(new Error(`JSON parse error: ${data.substring(0,200)}`)); } });
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

// ─── Auth ─────────────────────────────────────────────────────────────────────
async function getAuthHeader(catalystApp) {
  const creds = await catalystApp.connections().getConnectionCredentials('zoho_crm_connection');
  const h = (creds.headers || {}).Authorization || (creds.headers || {}).authorization;
  if (!h) throw new Error('No Authorization header in connection credentials');
  return h;
}

// ─── Date helpers ─────────────────────────────────────────────────────────────
// COQL requires UTC Z format. IST = UTC+5:30
// start of IST day → prev day 18:30 UTC; end of IST day → same day 18:29:59 UTC
function toUtcDatetime(dateStr, isEndOfDay) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const utcDate = isEndOfDay
    ? new Date(Date.UTC(y, m-1, d, 18, 29, 59))
    : new Date(Date.UTC(y, m-1, d-1, 18, 30, 0));
  return utcDate.toISOString().replace('.000Z', 'Z');
}

// ─── COQL helpers ─────────────────────────────────────────────────────────────
async function coqlCountPaged(authHeader, label, whereClause, module) {
  let total = 0, offset = 0;
  while (true) {
    const query = `SELECT id FROM ${module} WHERE ${whereClause} LIMIT ${PAGE_SIZE} OFFSET ${offset}`;
    try {
      const body = await crmPost(authHeader, '/crm/v3/coql', { select_query: query });
      if (body.status === 'error' || body.code) {
        console.error(`[COQL][${label}] error:`, JSON.stringify(body).substring(0, 300));
        break;
      }
      const rows = body.data || [];
      total += rows.length;
      if (!body.info || !body.info.more_records || rows.length < PAGE_SIZE || offset + PAGE_SIZE >= 10000) break;
      offset += PAGE_SIZE;
    } catch(e) { console.error(`[COQL][${label}] exception:`, e.message); break; }
  }
  console.log(`[COQL][${label}] total=${total}`);
  return total;
}

// Fetch actual bug records (paginated) for detail view
async function coqlFetchAll(authHeader, fields, module, whereClause, limit = 1000) {
  const results = [];
  let offset = 0;
  const select = fields.join(', ');
  while (results.length < limit) {
    const query = `SELECT ${select} FROM ${module} WHERE ${whereClause} LIMIT ${PAGE_SIZE} OFFSET ${offset}`;
    try {
      const body = await crmPost(authHeader, '/crm/v3/coql', { select_query: query });
      if (body.status === 'error' || body.code) { console.error('[coqlFetchAll] error:', JSON.stringify(body).substring(0,200)); break; }
      const rows = body.data || [];
      results.push(...rows);
      if (!body.info || !body.info.more_records || rows.length < PAGE_SIZE) break;
      offset += PAGE_SIZE;
    } catch(e) { console.error('[coqlFetchAll] exception:', e.message); break; }
  }
  return results;
}

// ─── User Lookup ──────────────────────────────────────────────────────────────
async function findUserIdByEmail(authHeader, email) {
  let page = 1;
  while (page <= 20) {
    try {
      const body = await crmGet(authHeader, `/crm/v3/users?type=AllUsers&per_page=200&page=${page}`);
      const users = body.users || [];
      const match = users.find(u => u.email && u.email.toLowerCase() === email.toLowerCase());
      if (match) return match.id;
      if (!body.info || !body.info.more_records || users.length < 200) break;
      page++;
    } catch(e) { console.error(`findUserIdByEmail(${email}) page=${page} error:`, e.message); break; }
  }
  return null;
}

// ─── Per-User Summary Stats ────────────────────────────────────────────────────
async function fetchUserStats(authHeader, user, userId, start, end) {
  if (!userId) return {
    email: user.email, name: user.name, user_id: null, error: 'User not found in CRM',
    tasks_assigned:0, tasks_completed:0, tasks_open:0,
    bugs_open:0, bugs_in_progress:0, bugs_to_test:0, bugs_fixed:0, bugs_closed:0, bugs_reported:0,
    deals_owned:0, deals_won:0, calls_made:0
  };

  const from = toUtcDatetime(start, false);
  const to   = toUtcDatetime(end,   true);

  const openStatusList  = OPEN_STATUSES.map(s => `'${s}'`).join(', ');
  const closedStatusList = CLOSED_STATUSES.map(s => `'${s}'`).join(', ');

  const [
    tasksAssigned, tasksCompleted, tasksOpen,
    bugsOpen, bugsInProgress, bugsToTest, bugsFixed, bugsClosed,
    bugsReported, dealsOwned, dealsWon, callsMade
  ] = await Promise.all([
    coqlCountPaged(authHeader, `${user.name}:tasks_assigned`,
      `Owner = '${userId}' AND Created_Time between '${from}' and '${to}'`, 'Tasks'),
    coqlCountPaged(authHeader, `${user.name}:tasks_completed`,
      `Owner = '${userId}' AND Status = 'Completed' AND Modified_Time between '${from}' and '${to}'`, 'Tasks'),
    coqlCountPaged(authHeader, `${user.name}:tasks_open`,
      `Owner = '${userId}' AND Status not in ('Completed', 'Deferred')`, 'Tasks'),
    coqlCountPaged(authHeader, `${user.name}:bugs_open`,
      `Owner = '${userId}' AND Status = 'Open'`, BUGS_MODULE),
    coqlCountPaged(authHeader, `${user.name}:bugs_inprogress`,
      `Owner = '${userId}' AND Status = 'In progress'`, BUGS_MODULE),
    coqlCountPaged(authHeader, `${user.name}:bugs_totest`,
      `Owner = '${userId}' AND Status = 'To be tested'`, BUGS_MODULE),
    coqlCountPaged(authHeader, `${user.name}:bugs_fixed`,
      `Owner = '${userId}' AND Status in ('Fixed', 'Fixed by other checkins', 'Fixed By DB update')`, BUGS_MODULE),
    coqlCountPaged(authHeader, `${user.name}:bugs_closed`,
      `Owner = '${userId}' AND Status in ('Closed', 'Closed - Not reproducible', 'Closed - Not an issue', 'Not an Issue', 'Not Reproducible', 'Duplicate Issue', 'Dependency Service Fixed')`, BUGS_MODULE),
    coqlCountPaged(authHeader, `${user.name}:bugs_reported`,
      `Created_By = '${userId}' AND Created_Time between '${from}' and '${to}'`, BUGS_MODULE),
    coqlCountPaged(authHeader, `${user.name}:deals_owned`,
      `Owner = '${userId}' AND Created_Time between '${from}' and '${to}'`, 'Deals'),
    coqlCountPaged(authHeader, `${user.name}:deals_won`,
      `Owner = '${userId}' AND Stage = 'Closed Won' AND Closing_Date between '${start}' and '${end}'`, 'Deals'),
    coqlCountPaged(authHeader, `${user.name}:calls_made`,
      `Owner = '${userId}' AND Created_Time between '${from}' and '${to}'`, 'Calls')
  ]);

  return {
    email: user.email, name: user.name, user_id: userId,
    tasks_assigned: tasksAssigned, tasks_completed: tasksCompleted, tasks_open: tasksOpen,
    bugs_open: bugsOpen, bugs_in_progress: bugsInProgress, bugs_to_test: bugsToTest,
    bugs_fixed: bugsFixed, bugs_closed: bugsClosed, bugs_reported: bugsReported,
    deals_owned: dealsOwned, deals_won: dealsWon, calls_made: callsMade
  };
}

// ─── Per-User Bug Detail ──────────────────────────────────────────────────────
async function fetchUserBugDetail(authHeader, userId, start, end) {
  const from = toUtcDatetime(start, false);
  const to   = toUtcDatetime(end, true);

  // Use 'Status in (ACTIVE list)' — COQL does not support 'not in' + 'is not null' combined.
  // This also naturally excludes null-status automation test records.
  const activeStatusCoql = ACTIVE_STATUSES.map(s => `'${s}'`).join(', ');

  const [allBugs, reportedThisMonth, statusHistory] = await Promise.all([
    // All active bugs owned by user — use explicit 'in' list (avoids null-status automation records)
    coqlFetchAll(authHeader, ['id','Name','Status','Severity','Created_Time','Modified_Time'],
      BUGS_MODULE, `Owner = '${userId}' AND Status in (${activeStatusCoql})`),
    // Bugs reported this month by user
    coqlFetchAll(authHeader, ['id','Name','Status','Severity','Created_Time'],
      BUGS_MODULE, `Created_By = '${userId}' AND Created_Time between '${from}' and '${to}'`),
    // Bugs resolved/fixed/closed this month
    coqlFetchAll(authHeader, ['id','Name','Status','Modified_Time'],
      BUGS_MODULE, `Owner = '${userId}' AND Status in ('Fixed', 'Fixed by other checkins', 'Fixed By DB update', 'Closed', 'Closed - Not reproducible') AND Modified_Time between '${from}' and '${to}'`)
  ]);

  // Count by status
  const statusCount = {};
  for (const bug of allBugs) {
    const s = bug.Status || 'Unknown';
    statusCount[s] = (statusCount[s] || 0) + 1;
  }

  return { allBugs, reportedThisMonth, resolvedThisMonth: statusHistory, statusCount };
}

// ─── Manager Dashboard Data ──────────────────────────────────────────────────
async function fetchUserManagerSnapshot(authHeader, user, userId, start, end) {
  const summary = await fetchUserStats(authHeader, user, userId, start, end);
  const from = toUtcDatetime(start, false);
  const to   = toUtcDatetime(end, true);

  const [taskTimeline, dealTimeline, bugReportedTimeline, visualWorkItems] = await Promise.all([
    coqlFetchAll(authHeader, ['id','Subject','Status','Created_Time','Modified_Time'], 'Tasks',
      `Owner = '${userId}' AND Created_Time between '${from}' and '${to}'`, 200),
    coqlFetchAll(authHeader, ['id','Deal_Name','Stage','Created_Time','Closing_Date'], 'Deals',
      `Owner = '${userId}' AND Created_Time between '${from}' and '${to}'`, 200),
    coqlFetchAll(authHeader, ['id','Name','Status','Severity','Created_Time'], BUGS_MODULE,
      `Created_By = '${userId}' AND Created_Time between '${from}' and '${to}'`, 200),
    // Visual Test status currently wired only for Paparao from QA_Audit_LoadTesting.
    // This module maps Paparao correctly through Automation_Developer.
    user.email === 'paparao.s@zohocorp.com'
      ? coqlFetchAll(authHeader, ['id','Name','UI_cases_added','LoadTesting_Status','Modified_Time'], 'QA_Audit_LoadTesting',
          `Automation_Developer = '${userId}'`, 500)
      : Promise.resolve([])
  ]);

  const timeline = [];
  taskTimeline.forEach(t => timeline.push({
    type: 'task',
    title: t.Subject || '(task)',
    status: t.Status,
    when: t.Created_Time,
    id: t.id,
    icon: '📋'
  }));
  dealTimeline.forEach(d => timeline.push({
    type: 'deal',
    title: d.Deal_Name || '(deal)',
    status: d.Stage,
    when: d.Created_Time,
    id: d.id,
    icon: '💼'
  }));
  bugReportedTimeline.forEach(b => timeline.push({
    type: 'bug',
    title: b.Name || '(bug)',
    status: b.Status,
    when: b.Created_Time,
    id: b.id,
    icon: '🐛'
  }));
  visualWorkItems.forEach(v => timeline.push({
    type: 'visual',
    title: v.Name || '(visual feature)',
    status: v.UI_cases_added || 'Unknown',
    when: v.Modified_Time,
    id: v.id,
    icon: '🖼️'
  }));
  timeline.sort((a,b) => String(b.when || '').localeCompare(String(a.when || '')));

  const visualStatusCounts = {};
  visualWorkItems.forEach(v => {
    const s = v.UI_cases_added || 'Unknown';
    visualStatusCounts[s] = (visualStatusCounts[s] || 0) + 1;
  });

  return {
    ...summary,
    timeline: timeline.slice(0, 50),
    tasks_timeline: taskTimeline,
    deals_timeline: dealTimeline,
    bugs_reported_timeline: bugReportedTimeline,
    visual_work_items: visualWorkItems,
    visual_status_counts: visualStatusCounts,
    calls_available: false,
    calls_permission_note: 'Calls data unavailable: missing Crm_Implied_View_Calls permission'
  };
}

function buildManagerHTML(periodLabel, snapshots, baseUrl, start, end) {
  const snapshotsJson = JSON.stringify(snapshots);
  const cards = snapshots.map(s => {
    const totalActivity = s.bugs_reported + s.tasks_assigned + s.deals_owned;
    const visualBlock = s.email === 'paparao.s@zohocorp.com' ? `
      <div class="mgr-visual-block">
        <div class="mgr-visual-title">🖼️ Visual Test Status</div>
        <div class="mgr-visual-chips">
          ${Object.entries(s.visual_status_counts || {}).map(([status,count]) => `<div class="vchip"><span>${count}</span>${status}</div>`).join('') || '<div class="mgr-empty">No visual test records</div>'}
        </div>
      </div>` : '';
    return `
    <div class="mgr-user-card">
      <div class="mgr-user-top">
        <div>
          <div class="mgr-user-name">${s.name}</div>
          <div class="mgr-user-email">${s.email}</div>
        </div>
        <a class="mgr-link" href="${baseUrl}/detail?userId=${s.user_id}&userName=${encodeURIComponent(s.name)}&start=${start}&end=${end}">Open detail →</a>
      </div>
      <div class="mgr-metrics">
        <div class="metric red"><span>${s.bugs_open}</span><small>Open Bugs</small></div>
        <div class="metric orange"><span>${s.bugs_in_progress}</span><small>In Progress</small></div>
        <div class="metric blue"><span>${s.bugs_to_test}</span><small>To Test</small></div>
        <div class="metric purple"><span>${s.bugs_reported}</span><small>Reported</small></div>
        <div class="metric emerald"><span>${s.tasks_assigned}</span><small>Tasks Added</small></div>
        <div class="metric amber"><span>${s.tasks_open}</span><small>Tasks Open</small></div>
        <div class="metric cyan"><span>${s.deals_owned}</span><small>Deals</small></div>
        <div class="metric gray"><span>${s.calls_available ? s.calls_made : '—'}</span><small>Calls</small></div>
      </div>
      <div class="mgr-mini-note">Daily visible activity items: <b>${totalActivity}</b></div>
      ${visualBlock}
      <div class="mgr-timeline">
        ${(s.timeline || []).slice(0,8).map(item => `
          <div class="tl-item">
            <div class="tl-icon">${item.icon}</div>
            <div class="tl-body">
              <div class="tl-title">${item.title}</div>
              <div class="tl-meta">${item.status || '—'} · ${(item.when || '').replace('T',' ').slice(0,16)}</div>
            </div>
          </div>`).join('') || '<div class="mgr-empty">No visible activity in selected range</div>'}
      </div>
    </div>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>WorkStatus Manager Dashboard</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  :root{--bg:#020617;--panel:#0f172a;--panel2:#111827;--border:#1f2937;--text:#e5e7eb;--muted:#94a3b8}
  body{font-family:-apple-system,BlinkMacSystemFont,'Inter','Segoe UI',sans-serif;background:radial-gradient(circle at top,#111827,#020617 55%);color:var(--text);padding:0}
  .wrap{max-width:1500px;margin:0 auto;padding:24px}
  .hero{padding:28px 0 18px;display:flex;justify-content:space-between;align-items:flex-start;gap:16px;flex-wrap:wrap}
  .hero h1{font-size:28px;font-weight:900;letter-spacing:-.6px}
  .hero p{font-size:13px;color:var(--muted);margin-top:6px}
  .hero-badges{display:flex;gap:8px;flex-wrap:wrap}
  .badge{background:#111827;border:1px solid var(--border);padding:8px 12px;border-radius:999px;font-size:11px;color:#cbd5e1;font-weight:700}
  .filters{background:rgba(15,23,42,.85);backdrop-filter:blur(10px);border:1px solid var(--border);border-radius:18px;padding:16px;display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:18px}
  .filters input{background:#020617;border:1px solid #334155;color:#e2e8f0;border-radius:10px;padding:9px 12px;font-size:12px}
  .filters a,.filters button{background:#2563eb;color:#fff;border:none;border-radius:10px;padding:10px 14px;font-size:12px;font-weight:700;text-decoration:none;cursor:pointer}
  .filters .ghost{background:#111827;border:1px solid #334155;color:#cbd5e1}
  .top-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin-bottom:18px}
  .top-card{background:linear-gradient(180deg,#111827,#0f172a);border:1px solid var(--border);border-radius:18px;padding:18px}
  .top-card .v{font-size:34px;font-weight:900;line-height:1}
  .top-card .l{font-size:11px;color:var(--muted);text-transform:uppercase;margin-top:6px;letter-spacing:.7px}
  .notice{margin-top:10px;font-size:11px;color:#fca5a5}
  .mgr-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(420px,1fr));gap:18px}
  .mgr-user-card{background:linear-gradient(180deg,#111827,#0b1220);border:1px solid var(--border);border-radius:20px;padding:18px;box-shadow:0 10px 30px rgba(0,0,0,.35)}
  .mgr-user-top{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;margin-bottom:14px}
  .mgr-user-name{font-size:18px;font-weight:800}
  .mgr-user-email{font-size:11px;color:var(--muted);margin-top:3px}
  .mgr-link{font-size:11px;color:#60a5fa;text-decoration:none;font-weight:800;white-space:nowrap}
  .mgr-metrics{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:12px}
  .metric{background:#0b1220;border:1px solid #1e293b;border-radius:14px;padding:12px;text-align:center}
  .metric span{display:block;font-size:22px;font-weight:900;line-height:1}
  .metric small{display:block;margin-top:5px;font-size:10px;color:var(--muted);text-transform:uppercase}
  .metric.red span{color:#fb7185}.metric.orange span{color:#fb923c}.metric.blue span{color:#60a5fa}.metric.purple span{color:#c084fc}.metric.emerald span{color:#34d399}.metric.amber span{color:#fbbf24}.metric.cyan span{color:#22d3ee}.metric.gray span{color:#94a3b8}
  .mgr-mini-note{font-size:11px;color:#cbd5e1;margin-bottom:10px}
  .mgr-visual-block{margin-bottom:10px;padding:10px 0;border-top:1px solid #1e293b;border-bottom:1px solid #1e293b}
  .mgr-visual-title{font-size:11px;color:#cbd5e1;font-weight:800;margin-bottom:8px;text-transform:uppercase;letter-spacing:.7px}
  .mgr-visual-chips{display:flex;flex-wrap:wrap;gap:8px}
  .vchip{background:#111827;border:1px solid #334155;border-radius:999px;padding:6px 10px;font-size:10px;color:#cbd5e1;font-weight:700}
  .vchip span{margin-right:6px;color:#60a5fa;font-size:12px}
  .mgr-timeline{border-top:1px solid #1e293b;padding-top:10px;display:flex;flex-direction:column;gap:8px}
  .tl-item{display:flex;gap:10px;align-items:flex-start;background:#0b1220;border:1px solid #1e293b;border-radius:12px;padding:10px}
  .tl-icon{width:28px;height:28px;border-radius:8px;background:#111827;display:flex;align-items:center;justify-content:center;font-size:14px;flex-shrink:0}
  .tl-title{font-size:12px;font-weight:700;color:#e5e7eb}
  .tl-meta{font-size:10px;color:var(--muted);margin-top:2px}
  .mgr-empty{font-size:12px;color:var(--muted);padding:12px 2px}
  .console{margin-top:22px;background:linear-gradient(180deg,#0b1220,#0f172a);border:1px solid var(--border);border-radius:22px;padding:18px}
  .console-head{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:14px}
  .console-title{font-size:18px;font-weight:900}
  .console-sub{font-size:12px;color:var(--muted);margin-top:4px}
  .console-filters{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-bottom:14px}
  .console-filters select,.console-filters input{background:#020617;border:1px solid #334155;color:#e2e8f0;border-radius:10px;padding:9px 12px;font-size:12px}
  .console-grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}
  .panel{background:#0b1220;border:1px solid #1e293b;border-radius:16px;padding:14px}
  .panel h3{font-size:13px;font-weight:800;margin-bottom:10px;color:#e2e8f0}
  .activity-list{display:flex;flex-direction:column;gap:8px;max-height:520px;overflow:auto;padding-right:4px}
  .activity-item{background:#111827;border:1px solid #1f2937;border-radius:12px;padding:12px}
  .activity-top{display:flex;justify-content:space-between;gap:12px;align-items:flex-start}
  .activity-title{font-size:12px;font-weight:800;color:#f8fafc}
  .activity-badges{display:flex;gap:6px;flex-wrap:wrap;margin-top:6px}
  .small-badge{background:#1e293b;border:1px solid #334155;color:#cbd5e1;border-radius:999px;padding:3px 8px;font-size:10px;font-weight:700}
  .activity-time{font-size:10px;color:#94a3b8;white-space:nowrap}
  .activity-meta{margin-top:6px;font-size:11px;color:#94a3b8;line-height:1.5}
  .timeline-table{width:100%;border-collapse:collapse}
  .timeline-table th,.timeline-table td{padding:8px 10px;border-bottom:1px solid #1f2937;font-size:11px;text-align:left;color:#cbd5e1;vertical-align:top}
  .timeline-table th{font-size:10px;color:#94a3b8;text-transform:uppercase}
  .empty-state{font-size:12px;color:#94a3b8;padding:16px;text-align:center}
  @media(max-width:980px){.console-grid{grid-template-columns:1fr}}
  @media(max-width:1000px){.top-grid{grid-template-columns:repeat(2,1fr)}}
  @media(max-width:640px){.top-grid{grid-template-columns:1fr}.mgr-metrics{grid-template-columns:repeat(2,1fr)}.wrap{padding:16px}}
  </style>
</head>
<body>
<div class="wrap">
  <div class="hero">
    <div>
      <h1>Manager Activity Dashboard</h1>
      <p>One view to track what everyone is doing daily · ${periodLabel}</p>
    </div>
    <div class="hero-badges">
      <div class="badge">Bugs ✅</div>
      <div class="badge">Tasks ✅</div>
      <div class="badge">Deals ✅</div>
      <div class="badge">Calls ❌ Permission missing</div>
    </div>
  </div>

  <form class="filters" method="get" action="${baseUrl}/manager">
    <input type="date" name="start" value="${start}">
    <input type="date" name="end" value="${end}">
    <button type="submit">Apply Range</button>
    <a class="ghost" href="${baseUrl}/manager">Reset</a>
    <a class="ghost" href="${baseUrl}/widget">Team Cards</a>
  </form>

  <div class="top-grid">
    <div class="top-card"><div class="v">${snapshots.reduce((a,s)=>a+(s.bugs_open+s.bugs_in_progress+s.bugs_to_test),0)}</div><div class="l">Total Active Bugs</div></div>
    <div class="top-card"><div class="v">${snapshots.reduce((a,s)=>a+s.bugs_reported,0)}</div><div class="l">Bugs Reported</div></div>
    <div class="top-card"><div class="v">${snapshots.reduce((a,s)=>a+s.tasks_assigned,0)}</div><div class="l">Tasks Added</div></div>
    <div class="top-card"><div class="v">${snapshots.reduce((a,s)=>a+s.deals_owned,0)}</div><div class="l">Deals Created</div><div class="notice">Calls blocked by CRM permission</div></div>
  </div>

  <div class="mgr-grid">${cards}</div>

  <div class="console">
    <div class="console-head">
      <div>
        <div class="console-title">Daily Activity Console</div>
        <div class="console-sub">Filter one user and inspect tasks created/completed, bugs reported/updated, and deals created within the selected date range</div>
      </div>
    </div>

    <div class="console-filters">
      <select id="userFilter" onchange="renderManagerConsole()">
        <option value="all">All Users</option>
        ${snapshots.map(s => `<option value="${s.user_id}">${s.name}</option>`).join('')}
      </select>
      <select id="moduleFilter" onchange="renderManagerConsole()">
        <option value="all">All Modules</option>
        <option value="task">Tasks</option>
        <option value="bug">Bugs</option>
        <option value="deal">Deals</option>
        <option value="visual">Visual Test</option>
      </select>
      <select id="statusFilter" onchange="renderManagerConsole()">
        <option value="all">All Statuses</option>
      </select>
      <input id="searchFilter" type="text" placeholder="Search feature / task / bug name" oninput="renderManagerConsole()">
    </div>

    <div class="console-grid">
      <div class="panel">
        <h3>Timeline of Work</h3>
        <div id="activityList" class="activity-list"></div>
      </div>
      <div class="panel">
        <h3>Timestamp Table</h3>
        <div id="timestampTableWrap"></div>
      </div>
    </div>
  </div>
</div>

<script>
const SNAPSHOTS = ${snapshotsJson};

function buildActivityRows() {
  const rows = [];
  SNAPSHOTS.forEach(u => {
    (u.tasks_timeline || []).forEach(t => rows.push({
      userId: u.user_id, user: u.name, module:'task',
      title: t.Subject || '(task)',
      status: t.Status || 'Unknown',
      created: t.Created_Time || '',
      updated: t.Modified_Time || '',
      detail: `Task created: ${t.Created_Time || '-'} | Last modified/completed: ${t.Modified_Time || '-'}`,
      icon: '📋'
    }));
    (u.bugs_reported_timeline || []).forEach(b => rows.push({
      userId: u.user_id, user: u.name, module:'bug',
      title: b.Name || '(bug)',
      status: b.Status || 'Unknown',
      created: b.Created_Time || '',
      updated: b.Modified_Time || '',
      detail: `Bug reported on: ${b.Created_Time || '-'} | Last known update: ${b.Modified_Time || '-'}`,
      icon: '🐛'
    }));
    (u.deals_timeline || []).forEach(d => rows.push({
      userId: u.user_id, user: u.name, module:'deal',
      title: d.Deal_Name || '(deal)',
      status: d.Stage || 'Unknown',
      created: d.Created_Time || '',
      updated: d.Closing_Date || '',
      detail: `Deal created: ${d.Created_Time || '-'} | Closing date: ${d.Closing_Date || '-'}`,
      icon: '💼'
    }));
    (u.visual_work_items || []).forEach(v => rows.push({
      userId: u.user_id, user: u.name, module:'visual',
      title: v.Name || '(visual feature)',
      status: v.UI_cases_added || 'Unknown',
      created: '',
      updated: v.Modified_Time || '',
      detail: `Visual Test status: ${v.UI_cases_added || '-'} | Last modified: ${v.Modified_Time || '-'}`,
      icon: '🖼️'
    }));
  });
  return rows.sort((a,b) => String(b.updated || b.created || '').localeCompare(String(a.updated || a.created || '')));
}

const ALL_ROWS = buildActivityRows();

function refreshStatusOptions(filteredRows) {
  const select = document.getElementById('statusFilter');
  const current = select.value;
  const statuses = Array.from(new Set(filteredRows.map(r => r.status).filter(Boolean))).sort();
  select.innerHTML = '<option value="all">All Statuses</option>' + statuses.map(s => `<option value="${s}">${s}</option>`).join('');
  if (statuses.includes(current)) select.value = current;
}

function renderManagerConsole() {
  const userId = document.getElementById('userFilter').value;
  const module = document.getElementById('moduleFilter').value;
  const status = document.getElementById('statusFilter').value;
  const q = (document.getElementById('searchFilter').value || '').toLowerCase();

  let rows = ALL_ROWS.filter(r => (userId === 'all' || r.userId === userId) && (module === 'all' || r.module === module));
  refreshStatusOptions(rows);
  rows = rows.filter(r => (status === 'all' || r.status === status) && (!q || r.title.toLowerCase().includes(q) || r.user.toLowerCase().includes(q)));

  const list = document.getElementById('activityList');
  const tableWrap = document.getElementById('timestampTableWrap');

  if (!rows.length) {
    list.innerHTML = '<div class="empty-state">No activity found for the selected filters</div>';
    tableWrap.innerHTML = '<div class="empty-state">No timestamp rows to show</div>';
    return;
  }

  list.innerHTML = rows.slice(0, 80).map(r => `
    <div class="activity-item">
      <div class="activity-top">
        <div>
          <div class="activity-title">${r.icon} ${r.title}</div>
          <div class="activity-badges">
            <span class="small-badge">${r.user}</span>
            <span class="small-badge">${r.module}</span>
            <span class="small-badge">${r.status}</span>
          </div>
        </div>
        <div class="activity-time">${(r.updated || r.created || '').replace('T',' ').slice(0,16)}</div>
      </div>
      <div class="activity-meta">${r.detail}</div>
    </div>
  `).join('');

  tableWrap.innerHTML = `
    <table class="timeline-table">
      <thead>
        <tr><th>User</th><th>Module</th><th>Title</th><th>Status</th><th>Created</th><th>Updated/Completed</th></tr>
      </thead>
      <tbody>
        ${rows.slice(0, 120).map(r => `
          <tr>
            <td>${r.user}</td>
            <td>${r.module}</td>
            <td>${r.title}</td>
            <td>${r.status}</td>
            <td>${(r.created || '').replace('T',' ').slice(0,16)}</td>
            <td>${(r.updated || '').replace('T',' ').slice(0,16)}</td>
          </tr>`).join('')}
      </tbody>
    </table>`;
}

renderManagerConsole();
</script>
</body>
</html>`;
}

// ─── HTML helpers ─────────────────────────────────────────────────────────────
// Colors for ALL status values confirmed from live data
const STATUS_COLORS = {
  // Active statuses
  'Open':                                    '#e03131',
  'In progress':                             '#e67700',
  'To be tested':                            '#1971c2',
  'To be tested - Not an Issue':             '#1971c2',
  'Reopen':                                  '#c92a2a',
  'Need to fix in automation':               '#7048e8',
  'Product flow change':                     '#7048e8',
  'Dependency Service Fixed':                '#9c36b5',
  // Fixed / resolved
  'Fixed':                                   '#2f9e44',
  'Fixed by other checkins':                 '#2f9e44',
  'Fixed By DB update':                      '#2f9e44',
  'fixed in automation':                     '#2f9e44',
  'Reverted':                                '#2f9e44',
  // Closed statuses
  'Closed':                                  '#495057',
  'Closed - Not reproducible':               '#868e96',
  'Closed - Not an issue':                   '#868e96',
  'Closed - Wrong interpretation of test case': '#868e96',
  'Not an Issue':                            '#868e96',
  'Not Reproducible':                        '#868e96',
  'Not Resolved':                            '#868e96',
  'Duplicate Issue':                         '#868e96',
  'Wrong interpretation of testcase':        '#868e96',
};

function statusBadge(status) {
  const color = STATUS_COLORS[status] || '#999';
  return `<span style="display:inline-block;padding:2px 8px;border-radius:12px;font-size:10px;font-weight:700;color:#fff;background:${color};white-space:nowrap">${status || 'Unknown'}</span>`;
}

// Severity values in this org: MustFix, Show stopper (not standard Critical/Major/Minor)
function severityBadge(sev) {
  if (!sev) return '';
  const map = {
    'Show stopper': '#c92a2a',
    'MustFix':      '#e67700',
    'Critical':     '#c92a2a',
    'Major':        '#e67700',
    'Minor':        '#1971c2',
    'Trivial':      '#868e96'
  };
  const c = map[sev] || '#666';
  return `<span style="display:inline-block;padding:1px 6px;border-radius:8px;font-size:9px;font-weight:700;color:#fff;background:${c};margin-left:4px">${sev}</span>`;
}

function bugRow(bug, linkBase) {
  const name = bug.Name || '(no title)';
  const date = bug.Created_Time ? bug.Created_Time.split('T')[0] : '';
  const modDate = bug.Modified_Time ? bug.Modified_Time.split('T')[0] : '';
  return `<tr>
    <td style="padding:8px 12px;border-bottom:1px solid #f0f0f0">
      <a href="https://crm.zoho.in/crm/crmlaunchpad/tab/CustomModule2/${bug.id}" target="_blank" style="color:#1971c2;text-decoration:none;font-weight:600;font-size:12px">${name}</a>
      ${severityBadge(bug.Severity)}
    </td>
    <td style="padding:8px 12px;border-bottom:1px solid #f0f0f0">${statusBadge(bug.Status)}</td>
    <td style="padding:8px 12px;border-bottom:1px solid #f0f0f0;font-size:11px;color:#666">${date}</td>
    <td style="padding:8px 12px;border-bottom:1px solid #f0f0f0;font-size:11px;color:#666">${modDate}</td>
  </tr>`;
}

// ─── Build Widget HTML ────────────────────────────────────────────────────────
function buildWidgetHTML(monthName, teamStats, baseUrl) {
  const PALETTE = ['#4f46e5','#0891b2','#059669','#d97706','#dc2626','#7c3aed'];
  const avatarColor = name => { let h=0; for(let i=0;i<name.length;i++) h=(h*31+name.charCodeAt(i))%PALETTE.length; return PALETTE[h]; };

  const cards = teamStats.map(u => {
    const initials  = u.name.split(' ').map(n=>n[0]).join('').toUpperCase().slice(0,2);
    const color     = avatarColor(u.name);
    const taskPct   = u.tasks_assigned > 0 ? Math.round((u.tasks_completed/u.tasks_assigned)*100) : 0;
    const detailUrl = `${baseUrl}/detail?userId=${u.user_id}&userName=${encodeURIComponent(u.name)}`;
    const totalActive = u.bugs_open + u.bugs_in_progress + u.bugs_to_test;

    return `<a href="${detailUrl}" style="text-decoration:none;color:inherit">
    <div class="card" style="--accent:${color}">
      <!-- card top accent bar -->
      <div class="card-bar"></div>
      <div class="card-body">
        <!-- header -->
        <div class="card-head">
          <div class="avatar">${initials}</div>
          <div>
            <div class="uname">${u.name}</div>
            <div class="uemail">${u.email}</div>
          </div>
          <div class="go-btn">View Details <span>→</span></div>
        </div>

        <!-- bug section -->
        <div class="section-label">🐛 Bugs — Active &amp; Status</div>
        <div class="chips">
          <div class="chip" style="--c:#e03131"><span>${u.bugs_open}</span>Open</div>
          <div class="chip" style="--c:#e67700"><span>${u.bugs_in_progress}</span>In Progress</div>
          <div class="chip" style="--c:#1971c2"><span>${u.bugs_to_test}</span>To Test</div>
          <div class="chip" style="--c:#2f9e44"><span>${u.bugs_fixed}</span>Fixed</div>
          <div class="chip" style="--c:#868e96"><span>${u.bugs_closed}</span>Closed</div>
          <div class="chip" style="--c:#9c36b5"><span>${u.bugs_reported}</span>Reported★</div>
        </div>

        <!-- divider -->
        <div class="divider"></div>

        <!-- task section -->
        <div class="section-label">📋 Tasks — This Month</div>
        <div class="task-row">
          <div class="task-box">
            <div class="task-val">${u.tasks_assigned}</div>
            <div class="task-lbl">Assigned</div>
          </div>
          <div class="task-box">
            <div class="task-val" style="color:#2f9e44">${u.tasks_completed}</div>
            <div class="task-lbl">Done</div>
          </div>
          <div class="task-box">
            <div class="task-val" style="color:#e67700">${u.tasks_open}</div>
            <div class="task-lbl">Open</div>
          </div>
          <div class="prog-wrap">
            <div class="prog-label">Completion ${taskPct}%</div>
            <div class="prog-track"><div class="prog-fill" style="width:${taskPct}%;background:var(--accent)"></div></div>
          </div>
        </div>
        ${u.error ? `<div class="err-note">⚠️ ${u.error}</div>` : ''}
      </div>
    </div></a>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>WorkStatus — ${monthName}</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  :root{--bg:#0f172a;--surface:#1e293b;--border:#334155;--text:#e2e8f0;--muted:#94a3b8;--radius:16px}
  html,body{min-height:100%;font-family:-apple-system,BlinkMacSystemFont,'Inter','Segoe UI',sans-serif;background:var(--bg);color:var(--text);font-size:14px}
  body{padding:0}

  /* ── TOP HERO ── */
  .hero{background:linear-gradient(135deg,#1e293b 0%,#0f172a 100%);border-bottom:1px solid var(--border);padding:28px 32px 24px}
  .hero-inner{max-width:1400px;margin:0 auto;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px}
  .hero-title{font-size:24px;font-weight:800;letter-spacing:-.5px;background:linear-gradient(90deg,#818cf8,#38bdf8);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
  .hero-sub{font-size:13px;color:var(--muted);margin-top:4px}
  .hero-badge{background:rgba(99,102,241,.15);border:1px solid rgba(99,102,241,.3);color:#818cf8;font-size:11px;font-weight:700;padding:5px 14px;border-radius:20px}
  .hero-actions{display:flex;gap:8px;align-items:center}
  .btn-ghost{background:rgba(255,255,255,.06);border:1px solid var(--border);color:var(--muted);font-size:12px;font-weight:600;padding:7px 16px;border-radius:10px;cursor:pointer;text-decoration:none;display:inline-flex;align-items:center;gap:6px;transition:background .15s}
  .btn-ghost:hover{background:rgba(255,255,255,.1)}

  /* ── GRID ── */
  .grid-wrap{max-width:1400px;margin:0 auto;padding:24px 32px}
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(360px,1fr));gap:20px}

  /* ── CARD ── */
  .card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);overflow:hidden;transition:transform .15s,box-shadow .2s;cursor:pointer}
  .card:hover{transform:translateY(-3px);box-shadow:0 12px 40px rgba(0,0,0,.5);border-color:var(--accent)}
  .card-bar{height:4px;background:var(--accent)}
  .card-body{padding:20px}
  .card-head{display:flex;align-items:center;gap:12px;margin-bottom:18px}
  .avatar{width:46px;height:46px;border-radius:12px;background:var(--accent);display:flex;align-items:center;justify-content:center;color:#fff;font-weight:800;font-size:16px;flex-shrink:0;letter-spacing:0}
  .uname{font-size:15px;font-weight:700;color:#f1f5f9}
  .uemail{font-size:11px;color:var(--muted);margin-top:2px}
  .go-btn{margin-left:auto;font-size:11px;font-weight:700;color:#818cf8;white-space:nowrap;display:flex;align-items:center;gap:4px;opacity:.8}
  .go-btn span{transition:transform .15s}
  .card:hover .go-btn span{transform:translateX(4px)}
  .section-label{font-size:10px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.8px;margin-bottom:10px}
  .divider{border:none;border-top:1px solid var(--border);margin:16px 0}

  /* ── BUG CHIPS ── */
  .chips{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:4px}
  .chip{background:rgba(255,255,255,.04);border:1px solid var(--border);border-radius:10px;padding:10px 8px;text-align:center;transition:background .12s;font-size:9px;color:var(--muted);font-weight:700;text-transform:uppercase;letter-spacing:.5px}
  .chip:hover{background:rgba(255,255,255,.08)}
  .chip span{display:block;font-size:22px;font-weight:800;color:var(--c);line-height:1;margin-bottom:4px}

  /* ── TASK ROW ── */
  .task-row{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
  .task-box{text-align:center;min-width:48px}
  .task-val{font-size:22px;font-weight:800;color:#f1f5f9;line-height:1}
  .task-lbl{font-size:9px;color:var(--muted);text-transform:uppercase;font-weight:700;margin-top:2px}
  .prog-wrap{flex:1;min-width:120px}
  .prog-label{font-size:10px;color:var(--muted);margin-bottom:5px}
  .prog-track{background:rgba(255,255,255,.08);border-radius:20px;height:5px;overflow:hidden}
  .prog-fill{height:100%;border-radius:20px;transition:width .5s ease}
  .err-note{font-size:11px;color:#f87171;margin-top:10px;padding:6px 10px;background:rgba(220,38,38,.1);border:1px solid rgba(220,38,38,.2);border-radius:8px}

  /* ── FOOTER ── */
  .footer{max-width:1400px;margin:0 auto;padding:16px 32px 24px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;font-size:12px;color:var(--muted)}
  .footer a{color:#818cf8;text-decoration:none;font-weight:600;margin-left:12px}
  @media(max-width:600px){.grid-wrap{padding:16px}.hero{padding:20px 16px}.chips{grid-template-columns:repeat(3,1fr)}}
</style>
</head>
<body>
<div class="hero">
  <div class="hero-inner">
    <div>
      <div class="hero-title">WorkStatus Dashboard</div>
      <div class="hero-sub">📅 ${monthName} &nbsp;·&nbsp; CRM Team Stats · Click any card for bug details</div>
    </div>
    <div class="hero-actions">
      <div class="hero-badge">★ = Bugs filed this month</div>
      <a href="javascript:location.reload()" class="btn-ghost">🔄 Refresh</a>
      <a href="https://crm.zoho.in/crm/crmlaunchpad/tab/CustomModule2" target="_blank" class="btn-ghost">🐛 CRM Bugs</a>
    </div>
  </div>
</div>

<div class="grid-wrap">
  <div class="grid">${cards}</div>
</div>

<div class="footer">
  <span>Updated: ${new Date().toLocaleString('en-IN',{timeZone:'Asia/Kolkata'})} IST</span>
  <div>
    <a href="javascript:location.reload()">🔄 Refresh</a>
    <a href="https://crm.zoho.in/crm/crmlaunchpad/tab/CustomModule2" target="_blank">🐛 Open Bugs in CRM</a>
  </div>
</div>
</body>
</html>`;
}

// ─── Build Detail HTML ────────────────────────────────────────────────────────
function buildDetailHTML(userName, monthName, detail, baseUrl, queryParams) {
  const { allBugs, reportedThisMonth, resolvedThisMonth, statusCount } = detail;
  const { userId, userName: uName, start, end, year, month } = queryParams;

  // Embed all bug data as JSON for client-side filtering
  const allBugsJson      = JSON.stringify(allBugs);
  const reportedJson     = JSON.stringify(reportedThisMonth);
  const resolvedJson     = JSON.stringify(resolvedThisMonth);

  // Status breakdown clickable bars
  const maxCount = Math.max(...Object.values(statusCount), 1);
  const statusBars = Object.entries(statusCount).sort((a,b)=>b[1]-a[1]).map(([status, count]) => {
    const color = STATUS_COLORS[status] || '#aaa';
    const pct   = Math.round((count/maxCount)*100);
    return `<div class="status-bar-row" onclick="filterByStatus('${status.replace(/'/g,"\\'")}',this)" title="Click to filter bugs by: ${status}">
      <div class="status-label">${status}</div>
      <div class="bar-track">
        <div class="bar-fill" style="width:${pct}%;background:${color}"></div>
      </div>
      <div class="bar-count" style="color:${color}">${count}</div>
    </div>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${userName} — Bug Details</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f0f2f8;color:#222;padding:16px;font-size:14px}
  a.back-btn{display:inline-flex;align-items:center;gap:6px;margin-bottom:14px;color:#1971c2;font-weight:700;text-decoration:none;font-size:13px;padding:6px 12px;background:#fff;border-radius:8px;box-shadow:0 1px 4px rgba(0,0,0,.08)}
  a.back-btn:hover{background:#e7f5ff}
  .page-header{background:linear-gradient(135deg,#1971c2,#1c4587);color:#fff;border-radius:14px;padding:18px 24px;margin-bottom:16px}
  .page-header h1{font-size:20px;font-weight:800}
  .page-header .subtitle{font-size:12px;opacity:.8;margin-top:4px}

  /* Filter bar */
  .filter-bar{background:#fff;border-radius:12px;padding:14px 18px;margin-bottom:14px;box-shadow:0 2px 8px rgba(0,0,0,.06);display:flex;flex-wrap:wrap;align-items:center;gap:12px}
  .filter-bar label{font-size:12px;font-weight:700;color:#666;white-space:nowrap}
  .filter-bar input[type=date]{border:1px solid #dee2e6;border-radius:6px;padding:5px 10px;font-size:12px;color:#333}
  .filter-bar select{border:1px solid #dee2e6;border-radius:6px;padding:5px 10px;font-size:12px;color:#333;background:#fff}
  .btn{padding:6px 14px;border-radius:8px;border:none;font-size:12px;font-weight:700;cursor:pointer}
  .btn-primary{background:#1971c2;color:#fff}
  .btn-primary:hover{background:#1864ab}
  .btn-outline{background:#fff;color:#1971c2;border:1.5px solid #1971c2}
  .btn-outline:hover{background:#e7f5ff}
  .active-filter-tag{display:inline-flex;align-items:center;gap:6px;background:#e7f5ff;color:#1971c2;font-size:11px;font-weight:700;padding:3px 10px;border-radius:20px}
  .active-filter-tag button{border:none;background:none;color:#1971c2;cursor:pointer;font-size:13px;line-height:1;padding:0}

  /* Summary stats */
  .summary-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:12px;margin-bottom:14px}
  .stat-card{background:#fff;border-radius:12px;padding:16px;box-shadow:0 2px 8px rgba(0,0,0,.06);cursor:pointer;border:2px solid transparent;transition:border-color .15s,transform .1s}
  .stat-card:hover{transform:translateY(-1px)}
  .stat-card.active{border-color:currentColor}
  .stat-card .val{font-size:28px;font-weight:800;line-height:1}
  .stat-card .lbl{font-size:11px;font-weight:600;color:#888;text-transform:uppercase;margin-top:4px}
  .stat-card .sub{font-size:10px;color:#bbb;margin-top:2px}

  /* Status breakdown */
  .grid2{display:grid;grid-template-columns:320px 1fr;gap:14px;margin-bottom:14px}
  .card{background:#fff;border-radius:12px;padding:18px;box-shadow:0 2px 8px rgba(0,0,0,.06)}
  .card h2{font-size:13px;font-weight:700;color:#444;margin-bottom:12px;display:flex;align-items:center;justify-content:space-between}
  .status-bar-row{display:flex;align-items:center;gap:8px;margin-bottom:6px;cursor:pointer;padding:4px 6px;border-radius:6px;transition:background .12s}
  .status-bar-row:hover,.status-bar-row.selected{background:#f0f4ff}
  .status-label{width:170px;font-size:11px;color:#555;text-align:right;flex-shrink:0}
  .bar-track{flex:1;background:#f0f0f0;border-radius:4px;height:12px;overflow:hidden}
  .bar-fill{height:100%;border-radius:4px;transition:width .3s}
  .bar-count{width:28px;font-size:12px;font-weight:800;text-align:right}

  /* Bug table */
  .table-section{background:#fff;border-radius:12px;box-shadow:0 2px 8px rgba(0,0,0,.06);margin-bottom:14px;overflow:hidden}
  .table-section .table-header{padding:14px 18px;border-bottom:1px solid #f0f0f0;display:flex;align-items:center;justify-content:space-between}
  .table-section .table-header h2{font-size:13px;font-weight:700;color:#444}
  .table-section .table-header .count-badge{font-size:11px;background:#f0f4ff;color:#1971c2;padding:2px 10px;border-radius:12px;font-weight:700}
  .search-box{padding:8px 18px;border-bottom:1px solid #f5f5f5}
  .search-box input{width:100%;padding:6px 12px;border:1px solid #dee2e6;border-radius:8px;font-size:12px;color:#333}
  table{width:100%;border-collapse:collapse}
  thead th{text-align:left;font-size:10px;font-weight:700;color:#aaa;text-transform:uppercase;padding:8px 12px;border-bottom:2px solid #f0f0f0;white-space:nowrap}
  tbody tr{transition:background .1s}
  tbody tr:hover td{background:#f8f9ff}
  .empty{color:#aaa;font-size:13px;padding:24px;text-align:center}
  .pagination{display:flex;align-items:center;justify-content:flex-end;gap:8px;padding:10px 18px;border-top:1px solid #f0f0f0;font-size:12px;color:#666}
  .pagination button{padding:4px 12px;border-radius:6px;border:1px solid #dee2e6;background:#fff;cursor:pointer;font-size:12px}
  .pagination button:disabled{opacity:.4;cursor:default}
  .pagination button.active{background:#1971c2;color:#fff;border-color:#1971c2}

  footer{text-align:center;margin-top:16px;font-size:11px;color:#bbb}
  footer a{color:#1971c2;font-weight:700;text-decoration:none;margin:0 6px}
  @media(max-width:700px){.grid2{grid-template-columns:1fr}.summary-grid{grid-template-columns:repeat(3,1fr)}}
</style>
</head>
<body>

<a class="back-btn" href="${baseUrl}/widget">← Team Dashboard</a>

<div class="page-header">
  <h1>🐛 ${userName}</h1>
  <div class="subtitle">Bug Details &nbsp;·&nbsp; <span id="periodLabel">${monthName}</span> &nbsp;·&nbsp; Click any stat or status bar to filter the table below</div>
</div>

<!-- Date/Filter bar -->
<div class="filter-bar">
  <label>📅 From</label>
  <input type="date" id="dateFrom" value="${start}">
  <label>To</label>
  <input type="date" id="dateTo" value="${end}">
  <button class="btn btn-primary" onclick="applyDateFilter()">Apply</button>
  <button class="btn btn-outline" onclick="resetFilters()">Reset</button>
  <div id="activeFilterTag" style="display:none" class="active-filter-tag">
    Filtered: <span id="filterLabel"></span>
    <button onclick="clearStatusFilter()">✕</button>
  </div>
  <div id="loadingIndicator" style="display:none;font-size:12px;color:#888">⏳ Loading...</div>
</div>

<!-- Summary stat cards -->
<div class="summary-grid" id="summaryGrid">
  <div class="stat-card" style="color:#e03131" onclick="showSection('active','all')">
    <div class="val" id="cntActive">${allBugs.length}</div>
    <div class="lbl">Active Bugs</div>
    <div class="sub">All open/in-progress</div>
  </div>
  <div class="stat-card" style="color:#e03131" onclick="showSection('active','Open')">
    <div class="val" id="cntOpen">${statusCount['Open']||0}</div>
    <div class="lbl">Open</div>
    <div class="sub">Not yet started</div>
  </div>
  <div class="stat-card" style="color:#e67700" onclick="showSection('active','In progress')">
    <div class="val" id="cntInProgress">${statusCount['In progress']||0}</div>
    <div class="lbl">In Progress</div>
    <div class="sub">Being worked on</div>
  </div>
  <div class="stat-card" style="color:#1971c2" onclick="showSection('active','To be tested')">
    <div class="val" id="cntToTest">${statusCount['To be tested']||0}</div>
    <div class="lbl">To Be Tested</div>
    <div class="sub">Ready for QA</div>
  </div>
  <div class="stat-card" style="color:#9c36b5" onclick="showSection('reported','all')">
    <div class="val" id="cntReported">${reportedThisMonth.length}</div>
    <div class="lbl">Reported ★</div>
    <div class="sub">Filed this month</div>
  </div>
  <div class="stat-card" style="color:#2e7d32" onclick="showSection('resolved','all')">
    <div class="val" id="cntResolved">${resolvedThisMonth.length}</div>
    <div class="lbl">Resolved</div>
    <div class="sub">Fixed/Closed this month</div>
  </div>
</div>

<!-- Status Breakdown + Month Summary row -->
<div class="grid2">
  <div class="card">
    <h2>📊 Status Breakdown <small style="font-size:10px;color:#aaa;font-weight:400">(click to filter)</small></h2>
    <div id="statusBars">${statusBars || '<div class="empty">No active bugs</div>'}</div>
  </div>
  <div class="card">
    <h2>📅 This Month <span style="font-size:10px;color:#aaa;font-weight:400">${monthName}</span></h2>
    <table>
      <tr onclick="showSection('reported','all')" style="cursor:pointer">
        <td style="padding:10px 0;font-size:13px;color:#555">📌 Bugs Reported</td>
        <td style="padding:10px 0;font-size:22px;font-weight:800;color:#9c36b5;text-align:right" id="mReported">${reportedThisMonth.length}</td>
      </tr>
      <tr onclick="showSection('resolved','all')" style="cursor:pointer">
        <td style="padding:10px 0;font-size:13px;color:#555">✅ Bugs Resolved/Fixed</td>
        <td style="padding:10px 0;font-size:22px;font-weight:800;color:#2e7d32;text-align:right" id="mResolved">${resolvedThisMonth.length}</td>
      </tr>
      <tr onclick="showSection('active','all')" style="cursor:pointer">
        <td style="padding:10px 0;font-size:13px;color:#555">🔴 Total Active</td>
        <td style="padding:10px 0;font-size:22px;font-weight:800;color:#e03131;text-align:right" id="mActive">${allBugs.length}</td>
      </tr>
    </table>
  </div>
</div>

<!-- Main bug table -->
<div class="table-section">
  <div class="table-header">
    <h2 id="tableTitle">🔴 Active Bugs</h2>
    <span class="count-badge" id="tableCount">${allBugs.length} bugs</span>
  </div>
  <div class="search-box">
    <input type="text" id="searchInput" placeholder="🔍 Search by bug name..." oninput="renderTable()">
  </div>
  <table>
    <thead>
      <tr>
        <th onclick="sortTable('Name')" style="cursor:pointer">Bug Name ↕</th>
        <th onclick="sortTable('Status')" style="cursor:pointer">Status ↕</th>
        <th onclick="sortTable('Severity')" style="cursor:pointer">Severity ↕</th>
        <th onclick="sortTable('Created_Time')" style="cursor:pointer">Created ↕</th>
        <th onclick="sortTable('Modified_Time')" style="cursor:pointer">Updated ↕</th>
      </tr>
    </thead>
    <tbody id="bugTableBody"></tbody>
  </table>
  <div class="pagination" id="paginationBar"></div>
</div>

<footer>
  Updated: ${new Date().toLocaleString('en-IN',{timeZone:'Asia/Kolkata'})} IST &nbsp;|&nbsp;
  <a href="${baseUrl}/widget">← Team Dashboard</a>
  <a href="https://crm.zoho.in/crm/crmlaunchpad/tab/CustomModule2" target="_blank">🌐 Open CRM Bugs</a>
</footer>

<script>
// ── Embedded data ──────────────────────────────────────────────────────────
const DATA = {
  active:   ${allBugsJson},
  reported: ${reportedJson},
  resolved: ${resolvedJson}
};

const BASE_URL   = '${baseUrl}';
const USER_ID    = '${userId}';
const USER_NAME  = '${encodeURIComponent(uName || userName)}';

// ── State ──────────────────────────────────────────────────────────────────
let currentSection  = 'active';
let currentStatus   = 'all';
let currentSort     = { key: 'Created_Time', dir: -1 };
let currentPage     = 1;
const PAGE_SIZE     = 30;

// ── Status colors ──────────────────────────────────────────────────────────
const STATUS_COLORS = ${JSON.stringify(STATUS_COLORS)};

function statusBadge(s) {
  const c = STATUS_COLORS[s] || '#aaa';
  return '<span style="display:inline-block;padding:2px 8px;border-radius:12px;font-size:10px;font-weight:700;color:#fff;background:'+c+';white-space:nowrap">'+(s||'?')+'</span>';
}
function severityBadge(s) {
  if(!s) return '';
  const m={
    'Show stopper':'#c92a2a','MustFix':'#e67700',
    'Critical':'#c92a2a','Major':'#e67700','Minor':'#1971c2','Trivial':'#868e96'
  };
  return '<span style="padding:1px 6px;border-radius:8px;font-size:9px;font-weight:700;color:#fff;background:'+(m[s]||'#666')+';margin-left:4px">'+s+'</span>';
}

// ── Show section ───────────────────────────────────────────────────────────
function showSection(section, status) {
  currentSection = section;
  currentStatus  = status;
  currentPage    = 1;

  // Update stat card highlighting
  document.querySelectorAll('.stat-card').forEach(c => c.classList.remove('active'));
  // Update status bars
  document.querySelectorAll('.status-bar-row').forEach(r => r.classList.remove('selected'));
  if(status !== 'all') {
    document.querySelectorAll('.status-bar-row').forEach(r => {
      if(r.dataset.status === status) r.classList.add('selected');
    });
  }

  // Update filter tag
  const tag = document.getElementById('activeFilterTag');
  const lbl = document.getElementById('filterLabel');
  if(status !== 'all') {
    tag.style.display='inline-flex';
    lbl.textContent = status;
  } else {
    tag.style.display='none';
  }

  // Update table title
  const titles = {
    active:   status==='all' ? '🔴 Active Bugs (All Time)' : '🔍 Filtered: '+status,
    reported: '📌 Bugs Reported This Month',
    resolved: '✅ Resolved/Fixed This Month'
  };
  document.getElementById('tableTitle').textContent = titles[section];

  // Clear search
  document.getElementById('searchInput').value = '';
  renderTable();
}

function filterByStatus(status, el) {
  el.dataset.status = status;
  showSection('active', status);
}

function clearStatusFilter() {
  showSection('active','all');
}

// ── Get current rows ───────────────────────────────────────────────────────
function getRows() {
  let rows = DATA[currentSection] || [];
  if(currentStatus !== 'all') {
    rows = rows.filter(r => r.Status === currentStatus);
  }
  const q = (document.getElementById('searchInput').value||'').toLowerCase();
  if(q) rows = rows.filter(r => (r.Name||'').toLowerCase().includes(q));
  return rows;
}

// ── Sort ───────────────────────────────────────────────────────────────────
function sortTable(key) {
  if(currentSort.key === key) currentSort.dir *= -1;
  else { currentSort.key = key; currentSort.dir = -1; }
  currentPage = 1;
  renderTable();
}

// ── Render ─────────────────────────────────────────────────────────────────
function renderTable() {
  let rows = getRows();

  // Sort
  rows = [...rows].sort((a,b) => {
    const va = a[currentSort.key]||'';
    const vb = b[currentSort.key]||'';
    return va < vb ? -currentSort.dir : va > vb ? currentSort.dir : 0;
  });

  // Count badge
  document.getElementById('tableCount').textContent = rows.length + ' bugs';

  // Paginate
  const total = rows.length;
  const pages = Math.ceil(total / PAGE_SIZE) || 1;
  if(currentPage > pages) currentPage = pages;
  const start = (currentPage-1)*PAGE_SIZE;
  const pageRows = rows.slice(start, start+PAGE_SIZE);

  // Build rows
  const html = pageRows.map(b => {
    const name = b.Name || '(no title)';
    const created = b.Created_Time ? b.Created_Time.split('T')[0] : '';
    const updated = b.Modified_Time ? b.Modified_Time.split('T')[0] : '';
    return '<tr><td style="padding:8px 12px;border-bottom:1px solid #f5f5f5">' +
      '<a href="https://crm.zoho.in/crm/crmlaunchpad/tab/CustomModule2/'+b.id+'" target="_blank" style="color:#1971c2;text-decoration:none;font-weight:600;font-size:12px">'+name+'</a>' +
      severityBadge(b.Severity) +
      '</td>' +
      '<td style="padding:8px 12px;border-bottom:1px solid #f5f5f5">'+statusBadge(b.Status)+'</td>' +
      '<td style="padding:8px 12px;border-bottom:1px solid #f5f5f5;font-size:11px;color:#888">'+b.Severity+'</td>' +
      '<td style="padding:8px 12px;border-bottom:1px solid #f5f5f5;font-size:11px;color:#888">'+created+'</td>' +
      '<td style="padding:8px 12px;border-bottom:1px solid #f5f5f5;font-size:11px;color:#888">'+updated+'</td>' +
      '</tr>';
  }).join('');

  document.getElementById('bugTableBody').innerHTML = html || '<tr><td colspan="5" class="empty">No bugs match the current filter</td></tr>';

  // Pagination
  let pag = '';
  if(pages > 1) {
    pag += '<button onclick="goPage('+(currentPage-1)+')" '+(currentPage===1?'disabled':'')+'>‹ Prev</button>';
    for(let i=1;i<=pages;i++) {
      if(i===1||i===pages||Math.abs(i-currentPage)<=2) {
        pag += '<button onclick="goPage('+i+')" class="'+(i===currentPage?'active':'')+'" >'+i+'</button>';
      } else if(Math.abs(i-currentPage)===3) {
        pag += '<span>…</span>';
      }
    }
    pag += '<button onclick="goPage('+(currentPage+1)+')" '+(currentPage===pages?'disabled':'')+'>Next ›</button>';
    pag += '<span style="margin-left:8px">Showing '+(start+1)+'–'+Math.min(start+PAGE_SIZE,total)+' of '+total+'</span>';
  }
  document.getElementById('paginationBar').innerHTML = pag;
}

function goPage(p) { currentPage = p; renderTable(); }

// ── Date filter (fetches new data from server) ─────────────────────────────
function applyDateFilter() {
  const from = document.getElementById('dateFrom').value;
  const to   = document.getElementById('dateTo').value;
  if(!from || !to) { alert('Please select both dates'); return; }
  document.getElementById('loadingIndicator').style.display = 'block';
  const url = BASE_URL+'/detail?userId='+USER_ID+'&userName='+USER_NAME+'&start='+from+'&end='+to;
  window.location.href = url;
}

function resetFilters() {
  clearStatusFilter();
  document.getElementById('searchInput').value = '';
  renderTable();
}

// ── Sync status bar data-status attributes ─────────────────────────────────
document.querySelectorAll('.status-bar-row').forEach(r => {
  const lbl = r.querySelector('.status-label');
  if(lbl) r.dataset.status = lbl.textContent.trim();
});

// ── Init ───────────────────────────────────────────────────────────────────
showSection('active','all');
</script>
</body>
</html>`;
}

// ─── Routes ───────────────────────────────────────────────────────────────────

app.get('/healthz', (req, res) => {
  res.json({ ok: true, service: 'WorkStatus Team Dashboard', ts: new Date().toISOString() });
});

// Team dashboard
app.get(['/', '/widget'], async (req, res) => {
  try {
    const app_cat    = catalyst.initialize(req);
    const authHeader = await getAuthHeader(app_cat);

    const now        = new Date();
    const year       = parseInt(req.query.year  || now.getFullYear(), 10);
    const monthParam = parseInt(req.query.month || (now.getMonth() + 1), 10);
    const firstDay   = new Date(year, monthParam - 1, 1);
    const lastDay    = new Date(year, monthParam, 0);
    const pad = n => String(n).padStart(2, '0');
    const fmt = d => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
    const start     = fmt(firstDay);
    const end       = fmt(lastDay);
    const monthName = firstDay.toLocaleString('en-IN', { month: 'long', year: 'numeric' });

    const baseUrl = `${req.protocol}://${req.get('host')}/server/crm-monthly-stats`;
    console.log(`[WorkStatus] Team dashboard for ${monthName}`);

    const teamStats = await Promise.all(
      TEAM.map(async u => {
        const userId = await findUserIdByEmail(authHeader, u.email);
        if (!userId) console.warn(`[WorkStatus] User not found: ${u.email}`);
        return fetchUserStats(authHeader, u, userId, start, end);
      })
    );

    if (req.query.format === 'json') {
      res.setHeader('Cache-Control', 'no-store');
      return res.json({ month: monthName, period: { start, end }, team: teamStats, generated_at: new Date().toISOString() });
    }

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    return res.send(buildWidgetHTML(monthName, teamStats, baseUrl));
  } catch (err) {
    console.error('[WorkStatus] Error:', err);
    return res.status(500).json({ error: err.message });
  }
});

// Unified manager dashboard
app.get('/manager', async (req, res) => {
  try {
    const app_cat    = catalyst.initialize(req);
    const authHeader = await getAuthHeader(app_cat);

    const pad = n => String(n).padStart(2, '0');
    const fmt = d => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
    const now = new Date();

    let start, end, periodLabel;
    if (req.query.start && req.query.end) {
      start = req.query.start;
      end   = req.query.end;
      const s = new Date(start + 'T12:00:00');
      const e = new Date(end   + 'T12:00:00');
      periodLabel = `${s.toLocaleDateString('en-IN',{day:'numeric',month:'short',year:'numeric'})} – ${e.toLocaleDateString('en-IN',{day:'numeric',month:'short',year:'numeric'})}`;
    } else {
      const firstDay = new Date(now.getFullYear(), now.getMonth(), 1);
      const lastDay  = new Date(now.getFullYear(), now.getMonth() + 1, 0);
      start = fmt(firstDay);
      end   = fmt(lastDay);
      periodLabel = firstDay.toLocaleString('en-IN', { month: 'long', year: 'numeric' });
    }

    const baseUrl = `${req.protocol}://${req.get('host')}/server/crm-monthly-stats`;

    const snapshots = await Promise.all(
      TEAM.map(async u => {
        const userId = await findUserIdByEmail(authHeader, u.email);
        return fetchUserManagerSnapshot(authHeader, u, userId, start, end);
      })
    );

    if (req.query.format === 'json') {
      res.setHeader('Cache-Control', 'no-store');
      return res.json({ period: { start, end, label: periodLabel }, team: snapshots, note: 'Calls unavailable due to CRM permission: Crm_Implied_View_Calls' });
    }

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    return res.send(buildManagerHTML(periodLabel, snapshots, baseUrl, start, end));
  } catch (err) {
    console.error('[WorkStatus] Manager dashboard error:', err);
    return res.status(500).json({ error: err.message });
  }
});

// Per-user drill-down detail
app.get('/detail', async (req, res) => {
  try {
    const app_cat    = catalyst.initialize(req);
    const authHeader = await getAuthHeader(app_cat);
    const { userId, userName } = req.query;

    if (!userId) return res.status(400).send('Missing ?userId=');

    const pad = n => String(n).padStart(2, '0');
    const fmt = d => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
    const now = new Date();

    let start, end, monthName;

    // Custom date range takes priority over month/year params
    if (req.query.start && req.query.end) {
      start = req.query.start;
      end   = req.query.end;
      // Build a readable label from the custom range
      const s = new Date(start + 'T12:00:00');
      const e = new Date(end   + 'T12:00:00');
      monthName = `${s.toLocaleDateString('en-IN',{day:'numeric',month:'short',year:'numeric'})} – ${e.toLocaleDateString('en-IN',{day:'numeric',month:'short',year:'numeric'})}`;
    } else {
      const year       = parseInt(req.query.year  || now.getFullYear(), 10);
      const monthParam = parseInt(req.query.month || (now.getMonth() + 1), 10);
      const firstDay   = new Date(year, monthParam - 1, 1);
      const lastDay    = new Date(year, monthParam, 0);
      start     = fmt(firstDay);
      end       = fmt(lastDay);
      monthName = firstDay.toLocaleString('en-IN', { month: 'long', year: 'numeric' });
    }

    const baseUrl = `${req.protocol}://${req.get('host')}/server/crm-monthly-stats`;
    console.log(`[WorkStatus] Detail for userId=${userId} (${userName}) range=${start}..${end}`);

    const detail = await fetchUserBugDetail(authHeader, userId, start, end);

    if (req.query.format === 'json') {
      res.setHeader('Cache-Control', 'no-store');
      return res.json({ userId, userName, month: monthName, period:{start,end}, ...detail });
    }

    const queryParams = { userId, userName, start, end };

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    return res.send(buildDetailHTML(userName || userId, monthName, detail, baseUrl, queryParams));
  } catch (err) {
    console.error('[WorkStatus] Detail error:', err);
    return res.status(500).json({ error: err.message });
  }
});

// ─── Debug routes ──────────────────────────────────────────────────────────────
app.get('/debug/users', async (req, res) => {
  try {
    const app_cat = catalyst.initialize(req);
    const authHeader = await getAuthHeader(app_cat);
    const results = { types: {} };
    for (const type of ['AllUsers','ActiveUsers','AdminUsers']) {
      try {
        const raw = await crmGet(authHeader, `/crm/v3/users?type=${type}&per_page=200`);
        results.types[type] = { count:(raw.users||[]).length, sample:(raw.users||[]).slice(0,5).map(u=>({id:u.id,email:u.email,name:u.full_name||u.name})) };
      } catch(e) { results.types[type] = {error:e.message}; }
    }
    return res.json(results);
  } catch(err) { return res.status(500).json({error:err.message}); }
});

app.get('/debug/modules', async (req, res) => {
  try {
    const app_cat = catalyst.initialize(req);
    const authHeader = await getAuthHeader(app_cat);
    const raw = await crmGet(authHeader, '/crm/v3/settings/modules');
    const modules = (raw.modules||[]).map(m=>({id:m.id,api_name:m.api_name,module_name:m.module_name,plural_label:m.plural_label,is_custom:m.generated_type==='custom'}));
    return res.json({ current_bugs_module: BUGS_MODULE, custom_modules: modules.filter(m=>m.is_custom), all_modules: modules });
  } catch(err) { return res.status(500).json({error:err.message}); }
});

// Discover fields for any module using CRM settings/fields API
// Example: /debug/fields?module=QA_Audit_Automation
app.get('/debug/fields', async (req, res) => {
  try {
    const app_cat = catalyst.initialize(req);
    const authHeader = await getAuthHeader(app_cat);
    const moduleApiName = req.query.module;
    if (!moduleApiName) return res.status(400).json({ error: 'Missing ?module=API_NAME' });

    const raw = await crmGet(authHeader, `/crm/v3/settings/fields?module=${encodeURIComponent(moduleApiName)}`);
    const fields = (raw.fields || []).map(f => ({
      api_name: f.api_name,
      field_label: f.field_label,
      data_type: f.data_type,
      visible: f.visible,
      read_only: f.read_only,
      required: f.system_mandatory || false
    }));

    return res.json({ module: moduleApiName, count: fields.length, fields });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// Inspect records from any module with arbitrary field list
// Example:
//   /debug/records?module=QA_Audit_LoadTesting&fields=id,Name,Owner,Automation_Developer,LoadTesting_Status,UI_cases_added&limit=20
app.get('/debug/records', async (req, res) => {
  try {
    const app_cat = catalyst.initialize(req);
    const authHeader = await getAuthHeader(app_cat);
    const moduleApiName = req.query.module;
    const fieldsParam   = req.query.fields;
    const limit         = parseInt(req.query.limit || '20', 10);
    const whereClause   = req.query.where || "id != '0'";

    if (!moduleApiName || !fieldsParam) {
      return res.status(400).json({ error: 'Missing ?module=API_NAME&fields=f1,f2,f3' });
    }

    const fields = fieldsParam.split(',').map(s => s.trim()).filter(Boolean);
    const query  = `SELECT ${fields.join(', ')} FROM ${moduleApiName} WHERE ${whereClause} LIMIT ${Math.min(limit, 100)}`;
    const body   = await crmPost(authHeader, '/crm/v3/coql', { select_query: query });
    return res.json({ module: moduleApiName, query, response: body });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.get('/debug/coql', async (req, res) => {
  try {
    const app_cat = catalyst.initialize(req);
    const authHeader = await getAuthHeader(app_cat);
    const query = req.query.q;
    if (!query) return res.status(400).json({error:'Missing ?q='});
    const body = await crmPost(authHeader, '/crm/v3/coql', {select_query: query});
    return res.json({query, response: body});
  } catch(err) { return res.status(500).json({error:err.message}); }
});

app.post('/debug/coql', async (req, res) => {
  try {
    const app_cat = catalyst.initialize(req);
    const authHeader = await getAuthHeader(app_cat);
    const query = req.body && req.body.q;
    if (!query) return res.status(400).json({error:'Missing body.q'});
    const body = await crmPost(authHeader, '/crm/v3/coql', {select_query: query});
    return res.json({query, response: body});
  } catch(err) { return res.status(500).json({error:err.message}); }
});

app.get('/debug/usercount', async (req, res) => {
  try {
    const app_cat = catalyst.initialize(req);
    const authHeader = await getAuthHeader(app_cat);
    const { userId, start, end } = req.query;
    if (!userId || !start || !end) return res.status(400).json({error:'Missing ?userId=&start=&end='});
    const from = toUtcDatetime(start, false);
    const to   = toUtcDatetime(end, true);
    const results = {};
    const queries = {
      bugs_open:     [`Owner = '${userId}' AND Status = 'Open'`, BUGS_MODULE],
      bugs_inprogress:[`Owner = '${userId}' AND Status = 'In progress'`, BUGS_MODULE],
      bugs_totest:   [`Owner = '${userId}' AND Status = 'To be tested'`, BUGS_MODULE],
      bugs_fixed:    [`Owner = '${userId}' AND Status in ('Fixed','Fixed by other checkins','Fixed By DB update')`, BUGS_MODULE],
      bugs_closed:   [`Owner = '${userId}' AND Status in ('Closed','Closed - Not reproducible','Closed - Not an issue','Not an Issue','Not Reproducible','Duplicate Issue','Dependency Service Fixed')`, BUGS_MODULE],
      bugs_reported: [`Created_By = '${userId}' AND Created_Time between '${from}' and '${to}'`, BUGS_MODULE],
      tasks_open:    [`Owner = '${userId}' AND Status not in ('Completed','Deferred')`, 'Tasks'],
      tasks_assigned:[`Owner = '${userId}' AND Created_Time between '${from}' and '${to}'`, 'Tasks'],
    };
    for (const [key, [where, mod]] of Object.entries(queries)) {
      const query = `SELECT id FROM ${mod} WHERE ${where} LIMIT 200 OFFSET 0`;
      try {
        const body = await crmPost(authHeader, '/crm/v3/coql', {select_query: query});
        if (body.status === 'error' || body.code) results[key] = {error: body.message || body.code, query};
        else results[key] = {count: (body.data||[]).length, more_records: body.info && body.info.more_records, query};
      } catch(e) { results[key] = {error: e.message, query}; }
    }
    return res.json({userId, period:{start,end,from,to}, results});
  } catch(err) { return res.status(500).json({error:err.message}); }
});

module.exports = app;
