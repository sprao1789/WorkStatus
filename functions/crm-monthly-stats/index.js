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

// Bug "open" statuses (all non-terminal states)
const OPEN_STATUSES   = ['Open', 'In progress', 'To be tested', 'Dependency Service Fixed'];
// Bug "closed/resolved" statuses
const CLOSED_STATUSES = ['Fixed', 'Fixed by other checkins', 'Fixed By DB update',
                          'Closed', 'Closed - Not reproducible', 'Closed - Not an issue',
                          'Not an Issue', 'Not Reproducible', 'Duplicate Issue'];

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

  const [allBugs, reportedThisMonth, statusHistory] = await Promise.all([
    // All open bugs owned by user
    coqlFetchAll(authHeader, ['id','Name','Status','Severity','Created_Time','Modified_Time'],
      BUGS_MODULE, `Owner = '${userId}' AND Status not in ('Closed', 'Closed - Not reproducible', 'Closed - Not an issue', 'Not an Issue', 'Not Reproducible', 'Duplicate Issue', 'Dependency Service Fixed', 'Fixed', 'Fixed by other checkins', 'Fixed By DB update')`),
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
const STATUS_COLORS = {
  'Open':                        '#e03131',
  'In progress':                 '#e67700',
  'To be tested':                '#1971c2',
  'Fixed':                       '#2f9e44',
  'Fixed by other checkins':     '#2f9e44',
  'Fixed By DB update':          '#2f9e44',
  'Closed':                      '#495057',
  'Closed - Not reproducible':   '#868e96',
  'Closed - Not an issue':       '#868e96',
  'Not an Issue':                '#868e96',
  'Not Reproducible':            '#868e96',
  'Duplicate Issue':             '#868e96',
  'Dependency Service Fixed':    '#9c36b5'
};

function statusBadge(status) {
  const color = STATUS_COLORS[status] || '#aaa';
  return `<span style="display:inline-block;padding:2px 8px;border-radius:12px;font-size:10px;font-weight:700;color:#fff;background:${color};white-space:nowrap">${status || 'Unknown'}</span>`;
}

function severityBadge(sev) {
  if (!sev) return '';
  const map = { 'Critical':'#c92a2a', 'Major':'#e67700', 'Minor':'#1971c2', 'Trivial':'#868e96' };
  const c = map[sev] || '#555';
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
function buildDetailHTML(userName, monthName, detail, baseUrl) {
  const { allBugs, reportedThisMonth, resolvedThisMonth, statusCount } = detail;

  // Status breakdown bars
  const statusBars = Object.entries(statusCount).sort((a,b)=>b[1]-a[1]).map(([status, count]) => {
    const color = STATUS_COLORS[status] || '#aaa';
    const max = Math.max(...Object.values(statusCount));
    const pct = Math.round((count/max)*100);
    return `<div style="display:flex;align-items:center;gap:10px;margin-bottom:6px">
      <div style="width:140px;font-size:11px;color:#555;text-align:right;flex-shrink:0">${status}</div>
      <div style="flex:1;background:#f0f0f0;border-radius:4px;height:14px;overflow:hidden">
        <div style="width:${pct}%;background:${color};height:100%;border-radius:4px"></div>
      </div>
      <div style="width:30px;font-size:12px;font-weight:700;color:${color}">${count}</div>
    </div>`;
  }).join('');

  const allBugsRows    = allBugs.map(b => bugRow(b, baseUrl)).join('');
  const reportedRows   = reportedThisMonth.map(b => bugRow(b, baseUrl)).join('');
  const resolvedRows   = resolvedThisMonth.map(b => bugRow(b, baseUrl)).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${userName} — Bug Details</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f0f2f8;color:#222;padding:16px}
  .back-btn{display:inline-block;margin-bottom:16px;color:#1971c2;font-weight:700;text-decoration:none;font-size:13px}
  .back-btn:hover{text-decoration:underline}
  .page-header{background:linear-gradient(135deg,#1971c2,#1c4587);color:#fff;border-radius:14px;padding:20px 28px;margin-bottom:20px}
  .page-header h1{font-size:20px;font-weight:800}
  .page-header p{font-size:13px;opacity:.85;margin-top:3px}
  .grid2{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px}
  .card{background:#fff;border-radius:14px;padding:20px;box-shadow:0 2px 12px rgba(0,0,0,.07)}
  .card h2{font-size:14px;font-weight:700;color:#333;margin-bottom:14px;display:flex;align-items:center;gap:8px}
  table{width:100%;border-collapse:collapse}
  th{text-align:left;font-size:11px;font-weight:700;color:#999;text-transform:uppercase;padding:6px 12px;border-bottom:2px solid #f0f0f0}
  tr:hover td{background:#fafafa}
  .empty{color:#999;font-size:13px;padding:16px;text-align:center}
  @media(max-width:700px){.grid2{grid-template-columns:1fr}}
</style>
</head>
<body>
<a class="back-btn" href="${baseUrl}/widget">← Back to Team Dashboard</a>

<div class="page-header">
  <h1>🐛 ${userName} — Bug Details</h1>
  <p>${monthName} &nbsp;·&nbsp; Active bugs owned · Reported this month · Resolved this month</p>
</div>

<div class="grid2">
  <div class="card">
    <h2>📊 Bug Status Breakdown (Active)</h2>
    ${statusBars || '<div class="empty">No active bugs</div>'}
  </div>
  <div class="card">
    <h2>📅 This Month Summary</h2>
    <table>
      <tr><td style="padding:8px 0;font-size:13px;color:#555">Bugs reported this month</td><td style="padding:8px 0;font-size:18px;font-weight:800;color:#9c36b5">${reportedThisMonth.length}</td></tr>
      <tr><td style="padding:8px 0;font-size:13px;color:#555">Bugs resolved/fixed this month</td><td style="padding:8px 0;font-size:18px;font-weight:800;color:#2e7d32">${resolvedThisMonth.length}</td></tr>
      <tr><td style="padding:8px 0;font-size:13px;color:#555">Total active bugs (all time)</td><td style="padding:8px 0;font-size:18px;font-weight:800;color:#e03131">${allBugs.length}</td></tr>
    </table>
  </div>
</div>

<div class="card" style="margin-bottom:16px">
  <h2>🔴 Active Bugs (All Time) <span style="font-size:12px;color:#aaa;font-weight:400">— ${allBugs.length} bugs</span></h2>
  ${allBugs.length ? `<table>
    <thead><tr><th>Bug Name</th><th>Status</th><th>Created</th><th>Last Updated</th></tr></thead>
    <tbody>${allBugsRows}</tbody>
  </table>` : '<div class="empty">No active bugs 🎉</div>'}
</div>

<div class="card" style="margin-bottom:16px">
  <h2>📌 Bugs Reported This Month <span style="font-size:12px;color:#aaa;font-weight:400">— ${reportedThisMonth.length} bugs</span></h2>
  ${reportedThisMonth.length ? `<table>
    <thead><tr><th>Bug Name</th><th>Status</th><th>Created</th><th>Last Updated</th></tr></thead>
    <tbody>${reportedRows}</tbody>
  </table>` : '<div class="empty">No bugs reported this month</div>'}
</div>

<div class="card" style="margin-bottom:16px">
  <h2>✅ Resolved/Fixed This Month <span style="font-size:12px;color:#aaa;font-weight:400">— ${resolvedThisMonth.length} bugs</span></h2>
  ${resolvedThisMonth.length ? `<table>
    <thead><tr><th>Bug Name</th><th>Status</th><th>Created</th><th>Last Updated</th></tr></thead>
    <tbody>${resolvedRows}</tbody>
  </table>` : '<div class="empty">No bugs resolved this month</div>'}
</div>

<div style="text-align:center;margin-top:16px;font-size:12px;color:#aaa">
  Updated: ${new Date().toLocaleString('en-IN',{timeZone:'Asia/Kolkata'})} IST
  &nbsp;|&nbsp; <a href="${baseUrl}/widget" style="color:#1971c2;font-weight:700;text-decoration:none">← Back to Team Dashboard</a>
  &nbsp;|&nbsp; <a href="https://crm.zoho.in/crm/crmlaunchpad/tab/CustomModule2" target="_blank" style="color:#e03131;font-weight:700;text-decoration:none">🌐 Open CRM Bugs</a>
</div>
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
    console.log(`[WorkStatus] Detail for userId=${userId} (${userName})`);

    const detail = await fetchUserBugDetail(authHeader, userId, start, end);

    if (req.query.format === 'json') {
      res.setHeader('Cache-Control', 'no-store');
      return res.json({ userId, userName, month: monthName, period:{start,end}, ...detail });
    }

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    return res.send(buildDetailHTML(userName || userId, monthName, detail, baseUrl));
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
