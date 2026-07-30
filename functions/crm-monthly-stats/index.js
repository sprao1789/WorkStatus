/**
 * WorkStatus — CRM Monthly Stats (Per-User Team Dashboard)
 * Catalyst Advanced IO Function using Express.js (Node.js 18)
 *
 * Uses Catalyst Connection "zoho_crm_connection" (OAuth, configured in Catalyst console).
 * No hardcoded tokens.
 *
 * Team members tracked:
 *   - paparao.s@zohocorp.com
 *   - muthu.p@zohocorp.com
 *   - naveenkarthick.s@zohocorp.com
 *   - vishwa.sr@zohocorp.com
 *   - harish.subramanian@zohocorp.com
 *
 * Routes:
 *   GET /server/crm-monthly-stats/          → JSON stats
 *   GET /server/crm-monthly-stats/widget    → HTML widget
 *   GET /server/crm-monthly-stats/healthz   → { ok: true }
 *
 * Required Catalyst Connection scopes:
 *   ZohoCRM.modules.ALL, ZohoCRM.settings.ALL,
 *   ZohoCRM.users.ALL, ZohoCRM.org.ALL,
 *   ZohoCRM.bulk.ALL, ZohoCRM.coql.READ
 */

'use strict';

const express  = require('express');
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
  { email: 'paparao.s@zohocorp.com',        name: 'Paparao S' },
  { email: 'muthu.p@zohocorp.com',           name: 'Muthu P' },
  { email: 'naveenkarthick.s@zohocorp.com',  name: 'Naveenkarthick S' },
  { email: 'vishwa.sr@zohocorp.com',         name: 'Vishwa SR' },
  { email: 'harish.subramanian@zohocorp.com',name: 'Harish Subramanian' }
];

// ─── Date helpers ─────────────────────────────────────────────────────────────

function getMonthRange(year, month) {
  const firstDay = new Date(year, month, 1);
  const lastDay  = new Date(year, month + 1, 0);
  const pad = n => String(n).padStart(2, '0');
  const fmt = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return {
    start:     fmt(firstDay),
    end:       fmt(lastDay),
    monthName: firstDay.toLocaleString('en-IN', { month: 'long', year: 'numeric' })
  };
}

// ─── CRM helpers ──────────────────────────────────────────────────────────────

async function coqlQuery(connection, query) {
  try {
    const resp = await connection.post(
      'https://www.zohoapis.in/crm/v3/coql',
      JSON.stringify({ select_query: query }),
      { 'Content-Type': 'application/json' }
    );
    const body = JSON.parse(resp.getBody());
    return body.data || [];
  } catch (e) {
    console.error('COQL error:', query.substring(0, 80), e.message);
    return [];
  }
}

async function coqlCount(connection, query) {
  const rows = await coqlQuery(connection, query);
  return (rows.length > 0 && rows[0].count !== undefined) ? rows[0].count : 0;
}

// Fetch Zoho CRM user ID by email
async function getUserId(connection, email) {
  try {
    const resp = await connection.get(
      `https://www.zohoapis.in/crm/v3/users?type=ActiveUsers`
    );
    const body = JSON.parse(resp.getBody());
    const users = body.users || [];
    const match = users.find(u => u.email && u.email.toLowerCase() === email.toLowerCase());
    return match ? match.id : null;
  } catch (e) {
    console.error(`getUserId error for ${email}:`, e.message);
    return null;
  }
}

// ─── Per-User Stats ────────────────────────────────────────────────────────────

async function fetchUserStats(connection, user, userId, start, end) {
  if (!userId) {
    return {
      email: user.email,
      name:  user.name,
      user_id: null,
      error: 'User not found in CRM',
      tasks_assigned:  0,
      tasks_completed: 0,
      tasks_open:      0,
      bugs_open:       0,
      bugs_closed:     0,
      bugs_assigned_by_user: 0,
      deals_owned:     0,
      deals_won:       0,
      calls_made:      0
    };
  }

  const tz   = '+05:30';
  const from = `${start}T00:00:00${tz}`;
  const to   = `${end}T23:59:59${tz}`;

  // Tasks — assigned TO this user this month
  const tasksAssignedQ = `SELECT count(id) as count FROM Tasks WHERE Owner = '${userId}' AND Created_Time >= '${from}' AND Created_Time <= '${to}'`;
  // Tasks — completed BY this user this month
  const tasksCompletedQ = `SELECT count(id) as count FROM Tasks WHERE Owner = '${userId}' AND Status = 'Completed' AND Modified_Time >= '${from}' AND Modified_Time <= '${to}'`;
  // Tasks — open (assigned, not yet done)
  const tasksOpenQ = `SELECT count(id) as count FROM Tasks WHERE Owner = '${userId}' AND Status != 'Completed'`;

  // Bugs (using Cases module in CRM — covers bug reports / issues)
  // Open bugs assigned to this user
  const bugsOpenQ = `SELECT count(id) as count FROM Cases WHERE Owner = '${userId}' AND Status != 'Closed'`;
  // Closed bugs this month by this user
  const bugsClosedQ = `SELECT count(id) as count FROM Cases WHERE Owner = '${userId}' AND Status = 'Closed' AND Modified_Time >= '${from}' AND Modified_Time <= '${to}'`;
  // Bugs reported/created by this user (Created_By)
  const bugsAssignedByQ = `SELECT count(id) as count FROM Cases WHERE Created_By = '${userId}' AND Created_Time >= '${from}' AND Created_Time <= '${to}'`;

  // Deals owned by this user this month
  const dealsOwnedQ = `SELECT count(id) as count FROM Deals WHERE Owner = '${userId}' AND Created_Time >= '${from}' AND Created_Time <= '${to}'`;
  // Deals won by this user this month
  const dealsWonQ = `SELECT count(id) as count FROM Deals WHERE Owner = '${userId}' AND Stage = 'Closed Won' AND Closing_Date >= '${start}' AND Closing_Date <= '${end}'`;
  // Calls made by this user this month
  const callsMadeQ = `SELECT count(id) as count FROM Calls WHERE Owner = '${userId}' AND Created_Time >= '${from}' AND Created_Time <= '${to}'`;

  const [
    tasksAssigned, tasksCompleted, tasksOpen,
    bugsOpen, bugsClosed, bugsAssignedBy,
    dealsOwned, dealsWon, callsMade
  ] = await Promise.all([
    coqlCount(connection, tasksAssignedQ),
    coqlCount(connection, tasksCompletedQ),
    coqlCount(connection, tasksOpenQ),
    coqlCount(connection, bugsOpenQ),
    coqlCount(connection, bugsClosedQ),
    coqlCount(connection, bugsAssignedByQ),
    coqlCount(connection, dealsOwnedQ),
    coqlCount(connection, dealsWonQ),
    coqlCount(connection, callsMadeQ)
  ]);

  return {
    email:   user.email,
    name:    user.name,
    user_id: userId,
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
        <div class="stat-item">
          <span class="stat-icon">📋</span>
          <div>
            <div class="stat-val">${u.tasks_assigned}</div>
            <div class="stat-lbl">Assigned Tasks</div>
          </div>
        </div>
        <div class="stat-item">
          <span class="stat-icon">✅</span>
          <div>
            <div class="stat-val">${u.tasks_completed}</div>
            <div class="stat-lbl">Completed</div>
          </div>
        </div>
        <div class="stat-item">
          <span class="stat-icon">⏳</span>
          <div>
            <div class="stat-val">${u.tasks_open}</div>
            <div class="stat-lbl">Open Tasks</div>
          </div>
        </div>
      </div>

      <div class="progress-bar-wrap">
        <div class="progress-label">Task Completion: ${taskPct}%</div>
        <div class="progress-bar">
          <div class="progress-fill" style="width:${taskPct}%;background:${color}"></div>
        </div>
      </div>

      <div class="stat-row">
        <div class="stat-item bug">
          <span class="stat-icon">🐛</span>
          <div>
            <div class="stat-val red">${u.bugs_open}</div>
            <div class="stat-lbl">Open Bugs</div>
          </div>
        </div>
        <div class="stat-item bug">
          <span class="stat-icon">🔒</span>
          <div>
            <div class="stat-val green">${u.bugs_closed}</div>
            <div class="stat-lbl">Closed Bugs</div>
          </div>
        </div>
        <div class="stat-item bug">
          <span class="stat-icon">📌</span>
          <div>
            <div class="stat-val">${u.bugs_assigned_by_user}</div>
            <div class="stat-lbl">Reported</div>
          </div>
        </div>
      </div>

      <div class="stat-row">
        <div class="stat-item">
          <span class="stat-icon">🎯</span>
          <div>
            <div class="stat-val">${u.deals_owned}</div>
            <div class="stat-lbl">Deals Owned</div>
          </div>
        </div>
        <div class="stat-item">
          <span class="stat-icon">🏆</span>
          <div>
            <div class="stat-val green">${u.deals_won}</div>
            <div class="stat-lbl">Deals Won</div>
          </div>
        </div>
        <div class="stat-item">
          <span class="stat-icon">📞</span>
          <div>
            <div class="stat-val">${u.calls_made}</div>
            <div class="stat-lbl">Calls Made</div>
          </div>
        </div>
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
  .progress-fill{height:100%;border-radius:20px;transition:width .3s}
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
<div class="team-grid">
  ${memberCards}
</div>
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
    const connection = app_cat.connection('zoho_crm_connection');

    // Try all user types
    const types = ['ActiveUsers', 'DeactiveUsers', 'AdminUsers', 'AllUsers'];
    const results = {};

    for (const type of types) {
      try {
        const resp = await connection.get(
          `https://www.zohoapis.in/crm/v3/users?type=${type}`
        );
        const body = JSON.parse(resp.getBody());
        results[type] = (body.users || []).map(u => ({
          id: u.id,
          email: u.email,
          name: u.full_name || u.name,
          role: u.role ? u.role.name : null,
          status: u.status
        }));
      } catch (e) {
        results[type] = { error: e.message };
      }
    }

    return res.json(results);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.get(['/', '/widget'], async (req, res) => {
  try {
    const app_cat = catalyst.initialize(req);
    const connection = app_cat.connection('zoho_crm_connection');

    const now        = new Date();
    const year       = parseInt(req.query.year  || now.getFullYear(), 10);
    const monthParam = parseInt(req.query.month || (now.getMonth() + 1), 10);
    const { start, end, monthName } = (() => {
      const firstDay = new Date(year, monthParam - 1, 1);
      const lastDay  = new Date(year, monthParam, 0);
      const pad = n => String(n).padStart(2, '0');
      const fmt = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
      return {
        start:     fmt(firstDay),
        end:       fmt(lastDay),
        monthName: firstDay.toLocaleString('en-IN', { month: 'long', year: 'numeric' })
      };
    })();

    const wantHTML = req.query.format === 'html' || req.path.endsWith('/widget');

    console.log(`[WorkStatus] Fetching team stats for ${monthName}`);

    // Step 1: Resolve user IDs for all team members in parallel
    const userIds = await Promise.all(
      TEAM.map(u => getUserId(connection, u.email))
    );

    // Step 2: Fetch per-user stats in parallel
    const teamStats = await Promise.all(
      TEAM.map((u, i) => fetchUserStats(connection, u, userIds[i], start, end))
    );

    if (wantHTML) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store, max-age=0');
      return res.send(buildWidgetHTML(monthName, teamStats));
    }

    res.setHeader('Cache-Control', 'no-store, max-age=0');
    return res.json({
      month:     monthName,
      period:    { start, end },
      team:      teamStats,
      generated_at: new Date().toISOString()
    });

  } catch (err) {
    console.error('[WorkStatus] Error:', err);
    return res.status(500).json({ error: err.message });
  }
});

module.exports = app;
