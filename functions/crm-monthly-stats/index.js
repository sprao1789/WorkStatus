/**
 * WorkStatus — CRM Monthly Stats (Per-User Team Dashboard)
 * Catalyst Advanced IO Function using Express.js (Node.js 18)
 *
 * Uses Catalyst Built-in Connection "zoho_crm_connection" (OAuth, configured in Catalyst console).
 *
 * Team members tracked:
 *   - paparao.s@zohocorp.com
 *   - muthu.p@zohocorp.com
 *   - naveenkarthick.s@zohocorp.com
 *   - vishwa.sr@zohocorp.com
 *   - harish.subramanian@zohocorp.com
 *
 * Routes:
 *   GET /server/crm-monthly-stats/              → JSON stats
 *   GET /server/crm-monthly-stats/widget        → HTML widget
 *   GET /server/crm-monthly-stats/healthz       → { ok: true }
 *   GET /server/crm-monthly-stats/debug/users   → list CRM users
 *   GET /server/crm-monthly-stats/debug/modules → list all CRM modules
 *   GET /server/crm-monthly-stats/debug/coql    → run a test COQL query
 *   GET /server/crm-monthly-stats/debug/sample  → sample records from any module
 *
 * COQL QUIRKS IN THIS ORG:
 *   - count(id) aggregate is NOT supported — returns "unsupported column"
 *   - Every SELECT requires a WHERE clause — bare "FROM Module LIMIT n" returns SYNTAX_ERROR
 *   - Solution: paginate using SELECT id FROM Module WHERE <filter> LIMIT 200 OFFSET N
 *     and sum up the total count across all pages.
 *   - Bugs Status values: "Open", "Fixed", "Closed"  (not standard Cases statuses)
 */

'use strict';

const express  = require('express');
const https    = require('https');
const catalyst = require('zcatalyst-sdk-node');

const app = express();
app.use(express.json());

// ─── Config ───────────────────────────────────────────────────────────────────

// API name of the bugs custom module (confirmed: api_name="Bugs", module_name="CustomModule2")
const BUGS_MODULE = 'Bugs';

// Max records per COQL page (CRM COQL max is 200)
const PAGE_SIZE = 200;

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

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

function crmGet(authHeader, path) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'www.zohoapis.in',
      path,
      method:   'GET',
      headers:  { 'Authorization': authHeader }
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

function crmPost(authHeader, path, body) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify(body);
    const options = {
      hostname: 'www.zohoapis.in',
      path,
      method:   'POST',
      headers:  {
        'Authorization':  authHeader,
        'Content-Type':   'application/json',
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

// ─── Auth ─────────────────────────────────────────────────────────────────────

async function getAuthHeader(catalystApp) {
  const creds = await catalystApp.connections().getConnectionCredentials('zoho_crm_connection');
  const authHeader = (creds.headers || {}).Authorization || (creds.headers || {}).authorization;
  if (!authHeader) throw new Error('No Authorization header in connection credentials');
  return authHeader;
}

// ─── COQL Count via Pagination ────────────────────────────────────────────────
//
// count(id) is not supported in COQL for this org.
// Instead we paginate SELECT id FROM Module WHERE ... LIMIT 200 OFFSET N
// and accumulate the total. CRM COQL max offset is 10,000.
//
async function coqlCountPaged(authHeader, label, whereClause, module) {
  let total  = 0;
  let offset = 0;
  const maxOffset = 10000; // CRM COQL hard limit

  while (true) {
    const query = `SELECT id FROM ${module} WHERE ${whereClause} LIMIT ${PAGE_SIZE} OFFSET ${offset}`;
    try {
      const body = await crmPost(authHeader, '/crm/v3/coql', { select_query: query });

      if (body.status === 'error' || body.code) {
        console.error(`[COQL][${label}] error at offset=${offset}:`, JSON.stringify(body).substring(0, 300));
        break;
      }

      const rows = body.data || [];
      total += rows.length;

      if (!body.info || !body.info.more_records || rows.length < PAGE_SIZE || offset + PAGE_SIZE >= maxOffset) {
        break;
      }
      offset += PAGE_SIZE;
    } catch (e) {
      console.error(`[COQL][${label}] exception at offset=${offset}:`, e.message);
      break;
    }
  }

  console.log(`[COQL][${label}] total=${total}`);
  return total;
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
    } catch (e) {
      console.error(`findUserIdByEmail(${email}) page=${page} error:`, e.message);
      break;
    }
  }
  return null;
}

// ─── Per-User Stats ────────────────────────────────────────────────────────────

async function fetchUserStats(authHeader, user, userId, start, end) {
  if (!userId) {
    return {
      email: user.email, name: user.name, user_id: null,
      error: 'User not found in CRM',
      tasks_assigned: 0, tasks_completed: 0, tasks_open: 0,
      bugs_open: 0, bugs_closed: 0, bugs_reported: 0,
      deals_owned: 0, deals_won: 0, calls_made: 0
    };
  }

  const from = `${start}T00:00:00+05:30`;
  const to   = `${end}T23:59:59+05:30`;

  console.log(`[WorkStatus] Fetching stats: ${user.email} (${userId}), ${start}..${end}`);

  // Bug Status values in this org: "Open", "Fixed", "Closed"
  // Open  = Status = 'Open'
  // Closed/Fixed = Status = 'Fixed' OR Status = 'Closed'
  const bugOpenFilter     = `Owner = '${userId}' AND Status = 'Open'`;
  const bugClosedFilter   = `Owner = '${userId}' AND (Status = 'Closed' OR Status = 'Fixed') AND Modified_Time >= '${from}' AND Modified_Time <= '${to}'`;
  const bugReportedFilter = `Created_By = '${userId}' AND Created_Time >= '${from}' AND Created_Time <= '${to}'`;

  const [
    tasksAssigned, tasksCompleted, tasksOpen,
    bugsOpen, bugsClosed, bugsReported,
    dealsOwned, dealsWon, callsMade
  ] = await Promise.all([

    // Tasks created this month owned by user
    coqlCountPaged(authHeader, `${user.name}:tasks_assigned`,
      `Owner = '${userId}' AND Created_Time >= '${from}' AND Created_Time <= '${to}'`,
      'Tasks'),

    // Tasks completed this month
    coqlCountPaged(authHeader, `${user.name}:tasks_completed`,
      `Owner = '${userId}' AND Status = 'Completed' AND Modified_Time >= '${from}' AND Modified_Time <= '${to}'`,
      'Tasks'),

    // Tasks currently open (all time)
    coqlCountPaged(authHeader, `${user.name}:tasks_open`,
      `Owner = '${userId}' AND Status != 'Completed'`,
      'Tasks'),

    // Bugs currently open (Status = Open, all time)
    coqlCountPaged(authHeader, `${user.name}:bugs_open`,
      bugOpenFilter, BUGS_MODULE),

    // Bugs closed/fixed this month
    coqlCountPaged(authHeader, `${user.name}:bugs_closed`,
      bugClosedFilter, BUGS_MODULE),

    // Bugs reported/created by user this month
    coqlCountPaged(authHeader, `${user.name}:bugs_reported`,
      bugReportedFilter, BUGS_MODULE),

    // Deals created this month
    coqlCountPaged(authHeader, `${user.name}:deals_owned`,
      `Owner = '${userId}' AND Created_Time >= '${from}' AND Created_Time <= '${to}'`,
      'Deals'),

    // Deals won this month (Closing_Date is a Date field, not DateTime)
    coqlCountPaged(authHeader, `${user.name}:deals_won`,
      `Owner = '${userId}' AND Stage = 'Closed Won' AND Closing_Date >= '${start}' AND Closing_Date <= '${end}'`,
      'Deals'),

    // Calls created this month
    coqlCountPaged(authHeader, `${user.name}:calls_made`,
      `Owner = '${userId}' AND Created_Time >= '${from}' AND Created_Time <= '${to}'`,
      'Calls')
  ]);

  return {
    email: user.email, name: user.name, user_id: userId,
    tasks_assigned:  tasksAssigned,
    tasks_completed: tasksCompleted,
    tasks_open:      tasksOpen,
    bugs_open:       bugsOpen,
    bugs_closed:     bugsClosed,
    bugs_reported:   bugsReported,
    deals_owned:     dealsOwned,
    deals_won:       dealsWon,
    calls_made:      callsMade
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
        <div class="stat-item"><span class="stat-icon">🔒</span><div><div class="stat-val green">${u.bugs_closed}</div><div class="stat-lbl">Fixed/Closed</div></div></div>
        <div class="stat-item"><span class="stat-icon">📌</span><div><div class="stat-val">${u.bugs_reported}</div><div class="stat-lbl">Reported</div></div></div>
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

app.get('/debug/users', async (req, res) => {
  try {
    const app_cat    = catalyst.initialize(req);
    const authHeader = await getAuthHeader(app_cat);
    const results    = { auth_preview: authHeader.substring(0,30)+'...', types: {} };

    for (const type of ['AllUsers', 'ActiveUsers', 'AdminUsers']) {
      try {
        const raw = await crmGet(authHeader, `/crm/v3/users?type=${type}&per_page=200`);
        results.types[type] = {
          count: (raw.users || []).length,
          status: raw.status, code: raw.code, message: raw.message,
          sample: (raw.users || []).slice(0,5).map(u => ({ id: u.id, email: u.email, name: u.full_name || u.name }))
        };
      } catch (e) {
        results.types[type] = { error: e.message };
      }
    }
    return res.json(results);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.get('/debug/modules', async (req, res) => {
  try {
    const app_cat    = catalyst.initialize(req);
    const authHeader = await getAuthHeader(app_cat);
    const raw        = await crmGet(authHeader, '/crm/v3/settings/modules');
    const modules    = (raw.modules || []).map(m => ({
      id: m.id, api_name: m.api_name, module_name: m.module_name,
      plural_label: m.plural_label, singular_label: m.singular_label,
      is_custom: m.generated_type === 'custom'
    }));
    return res.json({
      note: 'Find your bugs module in custom_modules. Check api_name.',
      current_bugs_module: BUGS_MODULE,
      custom_modules: modules.filter(m => m.is_custom),
      all_modules: modules
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.get('/debug/coql', async (req, res) => {
  try {
    const app_cat    = catalyst.initialize(req);
    const authHeader = await getAuthHeader(app_cat);
    const query      = req.query.q;
    if (!query) {
      return res.status(400).json({ error: 'Missing ?q= param' });
    }
    const body = await crmPost(authHeader, '/crm/v3/coql', { select_query: query });
    return res.json({ query, response: body });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.get('/debug/sample', async (req, res) => {
  try {
    const app_cat    = catalyst.initialize(req);
    const authHeader = await getAuthHeader(app_cat);
    const module     = req.query.module || BUGS_MODULE;
    const userId     = req.query.userId;
    const whereClause = userId
      ? `Owner = '${userId}'`
      : `id != '0'`;
    const query = `SELECT id, Owner, Status, Created_Time FROM ${module} WHERE ${whereClause} LIMIT 5`;
    const body  = await crmPost(authHeader, '/crm/v3/coql', { select_query: query });
    return res.json({ module, userId: userId || 'any', query, response: body });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

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
    const fmt = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const start     = fmt(firstDay);
    const end       = fmt(lastDay);
    const monthName = firstDay.toLocaleString('en-IN', { month: 'long', year: 'numeric' });

    const wantHTML = req.query.format === 'html' || req.path.endsWith('/widget');

    console.log(`[WorkStatus] Fetching team stats for ${monthName}`);

    const teamStats = await Promise.all(
      TEAM.map(async u => {
        const userId = await findUserIdByEmail(authHeader, u.email);
        if (!userId) console.warn(`[WorkStatus] User not found: ${u.email}`);
        return fetchUserStats(authHeader, u, userId, start, end);
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
