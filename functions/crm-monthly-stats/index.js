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

  // Build the COQL exclusion list from all known closed statuses
  const closedStatusCoql = CLOSED_STATUSES.map(s => `'${s}'`).join(', ');

  const [allBugs, reportedThisMonth, statusHistory] = await Promise.all([
    // All active bugs owned by user — exclude ALL closed/resolved statuses
    coqlFetchAll(authHeader, ['id','Name','Status','Severity','Created_Time','Modified_Time'],
      BUGS_MODULE, `Owner = '${userId}' AND Status not in (${closedStatusCoql})`),
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
  const colors = ['#e03131','#2196f3','#2e7d32','#f57c00','#6a1b9a'];
  const avatarColor = name => { let h=0; for(let i=0;i<name.length;i++) h=(h*31+name.charCodeAt(i))%colors.length; return colors[h]; };

  const cards = teamStats.map(u => {
    const initials = u.name.split(' ').map(n=>n[0]).join('').toUpperCase().slice(0,2);
    const color    = avatarColor(u.name);
    const bugsTotal = u.bugs_open + u.bugs_in_progress + u.bugs_to_test;
    const taskPct  = u.tasks_assigned > 0 ? Math.round((u.tasks_completed/u.tasks_assigned)*100) : 0;
    const detailUrl = `${baseUrl}/detail?userId=${u.user_id}&userName=${encodeURIComponent(u.name)}`;

    return `<a href="${detailUrl}" class="card-link">
    <div class="member-card">
      <div class="member-header">
        <div class="avatar" style="background:${color}">${initials}</div>
        <div class="member-info">
          <div class="member-name">${u.name}</div>
          <div class="member-email">${u.email}</div>
        </div>
        <div class="view-detail">Details →</div>
      </div>

      <div class="section-title">🐛 Bugs (Active)</div>
      <div class="stat-row">
        <div class="stat-item"><div class="stat-val red">${u.bugs_open}</div><div class="stat-lbl">Open</div></div>
        <div class="stat-item"><div class="stat-val orange">${u.bugs_in_progress}</div><div class="stat-lbl">In Progress</div></div>
        <div class="stat-item"><div class="stat-val blue">${u.bugs_to_test}</div><div class="stat-lbl">To Test</div></div>
        <div class="stat-item"><div class="stat-val green">${u.bugs_fixed}</div><div class="stat-lbl">Fixed</div></div>
        <div class="stat-item"><div class="stat-val gray">${u.bugs_closed}</div><div class="stat-lbl">Closed</div></div>
        <div class="stat-item"><div class="stat-val purple">${u.bugs_reported}</div><div class="stat-lbl">Reported★</div></div>
      </div>

      <div class="section-title">📋 Tasks (This Month)</div>
      <div class="stat-row">
        <div class="stat-item"><div class="stat-val">${u.tasks_assigned}</div><div class="stat-lbl">Assigned</div></div>
        <div class="stat-item"><div class="stat-val green">${u.tasks_completed}</div><div class="stat-lbl">Completed</div></div>
        <div class="stat-item"><div class="stat-val orange">${u.tasks_open}</div><div class="stat-lbl">Open</div></div>
      </div>
      <div class="progress-bar-wrap">
        <div class="progress-label">Task Completion: ${taskPct}%</div>
        <div class="progress-bar"><div class="progress-fill" style="width:${taskPct}%;background:${color}"></div></div>
      </div>

      ${u.error ? `<div class="error-note">⚠️ ${u.error}</div>` : ''}
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
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f0f2f8;color:#222;padding:16px}
  .page-header{background:linear-gradient(135deg,#e03131,#9b2226);color:#fff;border-radius:14px;padding:20px 28px;margin-bottom:20px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px}
  .page-header h1{font-size:22px;font-weight:800}
  .page-header p{font-size:13px;opacity:.85;margin-top:3px}
  .header-note{font-size:11px;opacity:.7;background:rgba(255,255,255,.15);padding:4px 10px;border-radius:8px}
  .team-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(340px,1fr));gap:16px}
  .card-link{text-decoration:none;color:inherit}
  .member-card{background:#fff;border-radius:14px;padding:20px;box-shadow:0 2px 12px rgba(0,0,0,.07);transition:transform .15s,box-shadow .15s;cursor:pointer}
  .member-card:hover{transform:translateY(-2px);box-shadow:0 6px 24px rgba(0,0,0,.12)}
  .member-header{display:flex;align-items:center;gap:12px;margin-bottom:14px;padding-bottom:12px;border-bottom:1px solid #f0f0f0}
  .avatar{width:44px;height:44px;border-radius:50%;display:flex;align-items:center;justify-content:center;color:#fff;font-weight:800;font-size:15px;flex-shrink:0}
  .member-name{font-weight:700;font-size:15px;color:#1a1a2e}
  .member-email{font-size:11px;color:#999;margin-top:2px}
  .view-detail{margin-left:auto;font-size:11px;color:#1971c2;font-weight:700;white-space:nowrap}
  .section-title{font-size:11px;font-weight:700;color:#888;text-transform:uppercase;margin:10px 0 6px;letter-spacing:.5px}
  .stat-row{display:grid;grid-template-columns:repeat(6,1fr);gap:6px;margin-bottom:8px}
  .stat-item{background:#f8f9fd;border-radius:8px;padding:8px 4px;text-align:center}
  .stat-val{font-size:18px;font-weight:800;color:#333;line-height:1}
  .stat-val.red{color:#e03131}
  .stat-val.orange{color:#e67700}
  .stat-val.blue{color:#1971c2}
  .stat-val.green{color:#2e7d32}
  .stat-val.gray{color:#868e96}
  .stat-val.purple{color:#9c36b5}
  .stat-lbl{font-size:9px;color:#aaa;text-transform:uppercase;margin-top:2px;font-weight:600}
  .progress-bar-wrap{margin-top:4px}
  .progress-label{font-size:11px;color:#888;margin-bottom:4px}
  .progress-bar{background:#f0f0f0;border-radius:20px;height:6px;overflow:hidden}
  .progress-fill{height:100%;border-radius:20px}
  .error-note{font-size:11px;color:#e03131;margin-top:8px;padding:6px;background:#fff5f5;border-radius:6px}
  .footer{text-align:center;margin-top:20px;font-size:12px;color:#aaa}
  .footer a{color:#e03131;text-decoration:none;font-weight:600;margin-left:8px}
  @media(max-width:480px){.stat-row{grid-template-columns:repeat(3,1fr)}}
</style>
</head>
<body>
<div class="page-header">
  <div>
    <h1>📊 WorkStatus — Team CRM Dashboard</h1>
    <p>${monthName} &nbsp;·&nbsp; Click a card to see full bug details</p>
  </div>
  <div class="header-note">★ Reported = bugs filed this month</div>
</div>
<div class="team-grid">${cards}</div>
<div class="footer">
  Updated: ${new Date().toLocaleString('en-IN',{timeZone:'Asia/Kolkata'})} IST
  <a href="javascript:location.reload()">🔄 Refresh</a>
  <a href="https://crm.zoho.in/crm/crmlaunchpad/tab/CustomModule2" target="_blank">🐛 Open Bugs</a>
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
