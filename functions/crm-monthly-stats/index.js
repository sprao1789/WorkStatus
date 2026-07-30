/**
 * WorkStatus — CRM Monthly Stats (Per-User Team Dashboard)
 * Catalyst Advanced IO Function using Express.js (Node.js 18)
 *
 * Uses Catalyst Built-in Connection "zoho_crm_connection" (OAuth, configured in Catalyst console).
 * Pattern: app.connection().getConnector('zoho_crm_connection').getAccessToken()
 *          then uses Node https to call Zoho CRM APIs with Bearer token.
 *
 * Team members tracked:
 *   - paparao.s@zohocorp.com
 *   - muthu.p@zohocorp.com
 *   - naveenkarthick.s@zohocorp.com
 *   - vishwa.sr@zohocorp.com
 *   - harish.subramanian@zohocorp.com
 *
 * Routes:
 *   GET /server/crm-monthly-stats/            → JSON stats
 *   GET /server/crm-monthly-stats/widget      → HTML widget
 *   GET /server/crm-monthly-stats/healthz     → { ok: true }
 *   GET /server/crm-monthly-stats/debug/users → list all CRM users (for debugging)
 */

'use strict';

const express  = require('express');
const https    = require('https');
const catalyst = require('zcatalyst-sdk-node');

const app = express();
app.use(express.json());

// Strip /server/crm-monthly-stats prefix so Express routes use clean paths
app.use((req, _res, next) => {
  const prefix = '/server/crm-monthly-stats';
  if (req.url.startsWith(prefix)) {
    req.url = req.url.slice(prefix.length) || '/';
  }
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

// ─── HTTP helper using Node https + Bearer token ───────────────────────────────

function crmGet(token, path) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'www.zohoapis.in',
      path:     path,
      method:   'GET',
      headers:  { 'Authorization': `Zoho-oauthtoken ${token}` }
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`JSON parse error: ${data.substring(0,200)}`)); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function crmPost(token, path, body) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify(body);
    const options = {
      hostname: 'www.zohoapis.in',
      path:     path,
      method:   'POST',
      headers:  {
        'Authorization': `Zoho-oauthtoken ${token}`,
        'Content-Type':  'application/json',
        'Content-Length': Buffer.byteLength(postData)
      }
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`JSON parse error: ${data.substring(0,200)}`)); }
      });
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

// ─── Get access token from Catalyst connection ─────────────────────────────────

async function getToken(catalystApp) {
  const connector = catalystApp.connection().getConnector('zoho_crm_connection');
  return await connector.getAccessToken();
}

// ─── CRM helpers ──────────────────────────────────────────────────────────────

async function coqlCount(token, query) {
  try {
    const body = await crmPost(token, '/crm/v3/coql', { select_query: query });
    return (body.data && body.data[0] && body.data[0].count !== undefined)
      ? body.data[0].count : 0;
  } catch (e) {
    console.error('COQL error:', e.message);
    return 0;
  }
}

async function getAllUsers(token) {
  try {
    const body = await crmGet(token, '/crm/v3/users?type=AllUsers&per_page=200');
    return body.users || [];
  } catch (e) {
    console.error('getAllUsers error:', e.message);
    return [];
  }
}

function findUserId(users, email) {
  const match = users.find(u => u.email && u.email.toLowerCase() === email.toLowerCase());
  return match ? match.id : null;
}

// ─── Per-User Stats ────────────────────────────────────────────────────────────

async function fetchUserStats(token, user, userId, start, end) {
  if (!userId) {
    return {
      email: user.email, name: user.name, user_id: null,
      error: 'User not found in CRM',
      tasks_assigned: 0, tasks_completed: 0, tasks_open: 0,
      bugs_open: 0, bugs_closed: 0, bugs_assigned_by_user: 0,
      deals_owned: 0, deals_won: 0, calls_made: 0
    };
  }

  const tz   = '+05:30';
  const from = `${start}T00:00:00${tz}`;
  const to   = `${end}T23:59:59${tz}`;

  const [
    tasksAssigned, tasksCompleted, tasksOpen,
    bugsOpen, bugsClosed, bugsAssignedBy,
    dealsOwned, dealsWon, callsMade
  ] = await Promise.all([
    coqlCount(token, `SELECT count(id) as count FROM Tasks WHERE Owner = '${userId}' AND Created_Time >= '${from}' AND Created_Time <= '${to}'`),
    coqlCount(token, `SELECT count(id) as count FROM Tasks WHERE Owner = '${userId}' AND Status = 'Completed' AND Modified_Time >= '${from}' AND Modified_Time <= '${to}'`),
    coqlCount(token, `SELECT count(id) as count FROM Tasks WHERE Owner = '${userId}' AND Status != 'Completed'`),
    coqlCount(token, `SELECT count(id) as count FROM Cases WHERE Owner = '${userId}' AND Status != 'Closed'`),
    coqlCount(token, `SELECT count(id) as count FROM Cases WHERE Owner = '${userId}' AND Status = 'Closed' AND Modified_Time >= '${from}' AND Modified_Time <= '${to}'`),
    coqlCount(token, `SELECT count(id) as count FROM Cases WHERE Created_By = '${userId}' AND Created_Time >= '${from}' AND Created_Time <= '${to}'`),
    coqlCount(token, `SELECT count(id) as count FROM Deals WHERE Owner = '${userId}' AND Created_Time >= '${from}' AND Created_Time <= '${to}'`),
    coqlCount(token, `SELECT count(id) as count FROM Deals WHERE Owner = '${userId}' AND Stage = 'Closed Won' AND Closing_Date >= '${start}' AND Closing_Date <= '${end}'`),
    coqlCount(token, `SELECT count(id) as count FROM Calls WHERE Owner = '${userId}' AND Created_Time >= '${from}' AND Created_Time <= '${to}'`)
  ]);

  return {
    email: user.email, name: user.name, user_id: userId,
    tasks_assigned:        tasksAssigned,
    tasks_completed:       tasksCompleted,
    tasks_open:            tasksOpen,
    bugs_open:             bugsOpen,
    bugs_closed:           bugsClosed,
    bugs_assigned_by_user: bugsAssignedBy,
    deals_owned:           dealsOwned,
    deals_won:             dealsWon,
    calls_made:            callsMade
  };
}

// ─── HTML Widget ───────────────────────────────────────────────────────────────

function buildWidgetHTML(monthName, teamStats) {
  const avatarColor = (name) => {
    const colors = ['#e03131','#2196f3','#2e7d32','#f57c00','#6a1b9a'];
    let h = 0;
    for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % colors.length;
    return colors[h];
  };

  const memberCards = teamStats.map(u => {
    const initials = u.name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0,2);
    const color    = avatarColor(u.name);
    const taskPct  = u.tasks_assigned > 0
      ? Math.round((u.tasks_completed / u.tasks_assigned) * 100) : 0;

    return `
    <div class="member-card">
      <div class="member-header">
        <div class="avatar" style="background:${color}">${initials}</div>
        <div class="member-info">
          <div class="member-name">${u.name}</div>
          <div class="member-email">${u.email}</div>
        </div>
      </div>
      <div class="stat-row">
        <div class="stat-item"><span class="stat-icon">📋</span><div><div class="stat-val">${u.tasks_assigned}</div><div class="stat-lbl">Assigned</div></div></div>
        <div class="stat-item"><span class="stat-icon">✅</span><div><div class="stat-val">${u.tasks_completed}</div><div class="stat-lbl">Completed</div></div></div>
        <div class="stat-item"><span class="stat-icon">⏳</span><div><div class="stat-val">${u.tasks_open}</div><div class="stat-lbl">Open Tasks</div></div></div>
      </div>
      <div class="progress-bar-wrap">
        <div class="progress-label">Task Completion: ${taskPct}%</div>
        <div class="progress-bar"><div class="progress-fill" style="width:${taskPct}%;background:${color}"></div></div>
      </div>
      <div class="stat-row">
        <div class="stat-item"><span class="stat-icon">🐛</span><div><div class="stat-val red">${u.bugs_open}</div><div class="stat-lbl">Open Bugs</div></div></div>
        <div class="stat-item"><span class="stat-icon">🔒</span><div><div class="stat-val green">${u.bugs_closed}</div><div class="stat-lbl">Closed Bugs</div></div></div>
        <div class="stat-item"><span class="stat-icon">📌</span><div><div class="stat-val">${u.bugs_assigned_by_user}</div><div class="stat-lbl">Reported</div></div></div>
      </div>
      <div class="stat-row">
        <div class="stat-item"><span class="stat-icon">🎯</span><div><div class="stat-val">${u.deals_owned}</div><div class="stat-lbl">Deals</div></div></div>
        <div class="stat-item"><span class="stat-icon">🏆</span><div><div class="stat-val green">${u.deals_won}</div><div class="stat-lbl">Won</div></div></div>
        <div class="stat-item"><span class="stat-icon">📞</span><div><div class="stat-val">${u.calls_made}</div><div class="stat-lbl">Calls</div></div></div>
      </div>
      ${u.error ? `<div class="error-note">⚠️ ${u.error}</div>` : ''}
    </div>`;
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
  .page-header{background:linear-gradient(135deg,#e03131,#9b2226);color:#fff;border-radius:14px;padding:20px 28px;margin-bottom:20px}
  .page-header h1{font-size:20px;font-weight:700}
  .page-header p{font-size:13px;opacity:.82;margin-top:3px}
  .team-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:16px}
  .member-card{background:#fff;border-radius:14px;padding:20px;box-shadow:0 2px 12px rgba(0,0,0,.07)}
  .member-header{display:flex;align-items:center;gap:14px;margin-bottom:16px;padding-bottom:14px;border-bottom:1px solid #f0f0f0}
  .avatar{width:44px;height:44px;border-radius:50%;display:flex;align-items:center;justify-content:center;color:#fff;font-weight:700;font-size:16px;flex-shrink:0}
  .member-name{font-weight:700;font-size:15px;color:#1a1a2e}
  .member-email{font-size:11px;color:#999;margin-top:2px}
  .stat-row{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:10px}
  .stat-item{background:#f8f9fd;border-radius:8px;padding:10px 8px;display:flex;align-items:center;gap:8px}
  .stat-icon{font-size:18px;flex-shrink:0}
  .stat-val{font-size:20px;font-weight:800;color:#333;line-height:1}
  .stat-val.red{color:#e03131}
  .stat-val.green{color:#2e7d32}
  .stat-lbl{font-size:10px;color:#999;text-transform:uppercase;margin-top:2px;font-weight:600}
  .progress-bar-wrap{margin-bottom:10px}
  .progress-label{font-size:11px;color:#888;margin-bottom:4px}
  .progress-bar{background:#f0f0f0;border-radius:20px;height:8px;overflow:hidden}
  .progress-fill{height:100%;border-radius:20px}
  .error-note{font-size:11px;color:#e03131;margin-top:8px;padding:6px;background:#fff5f5;border-radius:6px}
  .footer{text-align:center;margin-top:20px;font-size:12px;color:#aaa}
  .footer a{color:#e03131;text-decoration:none;font-weight:600;margin-left:8px}
  @media(max-width:480px){.stat-row{grid-template-columns:repeat(2,1fr)}}
</style>
</head>
<body>
<div class="page-header">
  <h1>📊 WorkStatus — Team CRM Dashboard</h1>
  <p>${monthName} &nbsp;·&nbsp; Per-Member Stats: Tasks · Bugs · Deals · Calls</p>
</div>
<div class="team-grid">${memberCards}</div>
<div class="footer">
  Updated: ${new Date().toLocaleString('en-IN',{timeZone:'Asia/Kolkata'})} IST
  <a href="javascript:location.reload()">🔄 Refresh</a>
  <a href="https://crm.zoho.in/crm/crmlaunchpad/tab/Home/begin" target="_blank">🌐 Open CRM</a>
</div>
</body>
</html>`;
}

// ─── Routes ───────────────────────────────────────────────────────────────────

app.get('/healthz', (req, res) => {
  res.json({ ok: true, service: 'WorkStatus Team Dashboard', ts: new Date().toISOString() });
});

// Debug: list all CRM users so we can verify the exact emails
app.get('/debug/users', async (req, res) => {
  try {
    const app_cat = catalyst.initialize(req);
    const token   = await getToken(app_cat);
    const users   = await getAllUsers(token);
    return res.json({
      total: users.length,
      users: users.map(u => ({ id: u.id, email: u.email, name: u.full_name || u.name, status: u.status }))
    });
  } catch (err) {
    console.error('/debug/users error:', err);
    return res.status(500).json({ error: err.message });
  }
});

app.get(['/', '/widget'], async (req, res) => {
  try {
    const app_cat = catalyst.initialize(req);
    const token   = await getToken(app_cat);

    const now        = new Date();
    const year       = parseInt(req.query.year  || now.getFullYear(), 10);
    const monthParam = parseInt(req.query.month || (now.getMonth() + 1), 10);
    const firstDay   = new Date(year, monthParam - 1, 1);
    const lastDay    = new Date(year, monthParam, 0);
    const pad = n => String(n).padStart(2, '0');
    const fmt = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const start     = fmt(firstDay);
    const end       = fmt(lastDay);
    const monthName = firstDay.toLocaleString('en-IN', { month: 'long', year: 'numeric' });

    const wantHTML = req.query.format === 'html' || req.path.endsWith('/widget');

    console.log(`[WorkStatus] Fetching team stats for ${monthName}`);

    // Fetch all CRM users once, then resolve IDs for each team member
    const allUsers = await getAllUsers(token);
    console.log(`[WorkStatus] CRM has ${allUsers.length} users`);

    const teamStats = await Promise.all(
      TEAM.map(u => {
        const userId = findUserId(allUsers, u.email);
        if (!userId) console.warn(`[WorkStatus] User not found: ${u.email}`);
        return fetchUserStats(token, u, userId, start, end);
      })
    );

    if (wantHTML) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store, max-age=0');
      return res.send(buildWidgetHTML(monthName, teamStats));
    }

    res.setHeader('Cache-Control', 'no-store, max-age=0');
    return res.json({ month: monthName, period: { start, end }, team: teamStats, generated_at: new Date().toISOString() });

  } catch (err) {
    console.error('[WorkStatus] Error:', err);
    return res.status(500).json({ error: err.message });
  }
});

module.exports = app;
