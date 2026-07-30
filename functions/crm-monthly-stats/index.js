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
 *   GET /server/crm-monthly-stats/                → JSON stats
 *   GET /server/crm-monthly-stats/widget          → HTML widget
 *   GET /server/crm-monthly-stats/healthz         → { ok: true }
 *   GET /server/crm-monthly-stats/debug/users     → list CRM users
 *   GET /server/crm-monthly-stats/debug/modules   → list all CRM modules (find CustomModule2 API name)
 *   GET /server/crm-monthly-stats/debug/coql      → run a test COQL query
 *
 * BUG FIX NOTE:
 *   Bugs/Issues in this org live in a custom module (CustomModule2 in the URL).
 *   The API name for that module is discovered via /debug/modules.
 *   Set BUGS_MODULE below to the correct API name once confirmed.
 *   Common values: "Bugs", "Issues", "CustomModule2", "CustomModule3", etc.
 */

'use strict';

const express  = require('express');
const https    = require('https');
const catalyst = require('zcatalyst-sdk-node');

const app = express();
app.use(express.json());

// ─── BUG MODULE CONFIG ────────────────────────────────────────────────────────
//
// YOUR BUG MODULE IS A CUSTOM MODULE (visible as CustomModule2 in the CRM URL).
// To find the correct API name, deploy this code and hit:
//   GET /server/crm-monthly-stats/debug/modules
// Look for the module with plural_label "Bugs" or similar.
// Then set BUGS_MODULE to its "api_name" value below.
//
// Common API names seen in Zoho CRM orgs: "Bugs", "Issues", "CustomModule2__c"
// For now we default to "Bugs" — the most common name for this type of module.
const BUGS_MODULE = 'Bugs';

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

// ─── HTTP helpers using Node https ────────────────────────────────────────────

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

// ─── Get auth header from Catalyst connection ─────────────────────────────────

async function getAuthHeader(catalystApp) {
  const creds = await catalystApp.connections().getConnectionCredentials('zoho_crm_connection');
  const authHeader = (creds.headers || {}).Authorization || (creds.headers || {}).authorization;
  if (!authHeader) throw new Error('No Authorization header in connection credentials');
  return authHeader;
}

// ─── CRM helpers ──────────────────────────────────────────────────────────────

/**
 * Run a COQL SELECT count(...) query and return the count.
 * Returns 0 on any error, and logs the full CRM response for debugging.
 */
async function coqlCount(authHeader, label, query) {
  try {
    const body = await crmPost(authHeader, '/crm/v3/coql', { select_query: query });

    // Log the full response for debugging (will appear in Catalyst function logs)
    if (body.status === 'error' || body.code) {
      console.error(`[COQL][${label}] Error response:`, JSON.stringify(body).substring(0, 400));
      return 0;
    }

    if (body.data && body.data[0] !== undefined) {
      // COUNT returns a single row; the column may be named "count" or the aggregate alias
      const row = body.data[0];
      const val = row.count !== undefined ? row.count
                : row.cnt   !== undefined ? row.cnt
                : Object.values(row)[0];
      console.log(`[COQL][${label}] count=${val}`);
      return typeof val === 'number' ? val : parseInt(val, 10) || 0;
    }

    // No data rows — module exists but nothing matches
    console.log(`[COQL][${label}] no data rows (0)`);
    return 0;
  } catch (e) {
    console.error(`[COQL][${label}] exception:`, e.message);
    return 0;
  }
}

// Search CRM for a specific user email by paginating through all users
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
      bugs_open: 0, bugs_closed: 0, bugs_assigned_by_user: 0,
      deals_owned: 0, deals_won: 0, calls_made: 0
    };
  }

  // Zoho CRM COQL datetime format: 'YYYY-MM-DDTHH:MM:SS+05:30'
  // NOTE: The timezone suffix must NOT be URL-encoded in the query string;
  //       it's fine inside the POST body.
  const from = `${start}T00:00:00+05:30`;
  const to   = `${end}T23:59:59+05:30`;

  // Bug module status values — adjust if your module uses different picklist values.
  // Common patterns:
  //   Open bugs: Status != 'Closed' (or != 'Fixed', != 'Verified')
  //   Closed bugs: Status = 'Closed' (or = 'Fixed', or = 'Verified')
  // We use a broad "not closed/not verified/not fixed" for open bugs.
  const bugOpenStatuses  = `Status != 'Closed' AND Status != 'Fixed' AND Status != 'Verified'`;
  const bugClosedStatus  = `Status = 'Closed'`;

  console.log(`[WorkStatus] Fetching stats for ${user.email} (id=${userId}), period ${start}..${end}, bugs module=${BUGS_MODULE}`);

  const [
    tasksAssigned, tasksCompleted, tasksOpen,
    bugsOpen, bugsClosed, bugsAssignedBy,
    dealsOwned, dealsWon, callsMade
  ] = await Promise.all([

    // Tasks — created this month, owned by user
    coqlCount(authHeader, `${user.name}:tasks_assigned`,
      `SELECT count(id) FROM Tasks WHERE Owner = '${userId}' AND Created_Time >= '${from}' AND Created_Time <= '${to}'`),

    // Tasks — completed (status=Completed) this month
    coqlCount(authHeader, `${user.name}:tasks_completed`,
      `SELECT count(id) FROM Tasks WHERE Owner = '${userId}' AND Status = 'Completed' AND Modified_Time >= '${from}' AND Modified_Time <= '${to}'`),

    // Tasks — currently open (no date filter, all time)
    coqlCount(authHeader, `${user.name}:tasks_open`,
      `SELECT count(id) FROM Tasks WHERE Owner = '${userId}' AND Status != 'Completed'`),

    // Bugs — open (all time, owned by user) — uses BUGS_MODULE not Cases
    coqlCount(authHeader, `${user.name}:bugs_open`,
      `SELECT count(id) FROM ${BUGS_MODULE} WHERE Owner = '${userId}' AND ${bugOpenStatuses}`),

    // Bugs — closed this month (owned by user)
    coqlCount(authHeader, `${user.name}:bugs_closed`,
      `SELECT count(id) FROM ${BUGS_MODULE} WHERE Owner = '${userId}' AND ${bugClosedStatus} AND Modified_Time >= '${from}' AND Modified_Time <= '${to}'`),

    // Bugs — reported/created by user this month (regardless of owner)
    coqlCount(authHeader, `${user.name}:bugs_reported`,
      `SELECT count(id) FROM ${BUGS_MODULE} WHERE Created_By = '${userId}' AND Created_Time >= '${from}' AND Created_Time <= '${to}'`),

    // Deals — created this month, owned by user
    coqlCount(authHeader, `${user.name}:deals_owned`,
      `SELECT count(id) FROM Deals WHERE Owner = '${userId}' AND Created_Time >= '${from}' AND Created_Time <= '${to}'`),

    // Deals — won this month (Closing_Date is a Date, not DateTime — use date format only)
    coqlCount(authHeader, `${user.name}:deals_won`,
      `SELECT count(id) FROM Deals WHERE Owner = '${userId}' AND Stage = 'Closed Won' AND Closing_Date >= '${start}' AND Closing_Date <= '${end}'`),

    // Calls — created this month, owned by user
    coqlCount(authHeader, `${user.name}:calls_made`,
      `SELECT count(id) FROM Calls WHERE Owner = '${userId}' AND Created_Time >= '${from}' AND Created_Time <= '${to}'`)
  ]);

  return {
    email: user.email, name: user.name, user_id: userId,
    bugs_module:           BUGS_MODULE,
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

// Debug: list all CRM users — returns raw API response for each type
app.get('/debug/users', async (req, res) => {
  try {
    const app_cat    = catalyst.initialize(req);
    const authHeader = await getAuthHeader(app_cat);

    const results = { auth_preview: authHeader.substring(0,30)+'...', types: {} };

    for (const type of ['AllUsers', 'ActiveUsers', 'AdminUsers']) {
      try {
        const raw = await crmGet(authHeader, `/crm/v3/users?type=${type}&per_page=200`);
        results.types[type] = {
          count: (raw.users || []).length,
          status: raw.status,
          code: raw.code,
          message: raw.message,
          sample: (raw.users || []).slice(0,5).map(u => ({ id: u.id, email: u.email, name: u.full_name || u.name }))
        };
      } catch (e) {
        results.types[type] = { error: e.message };
      }
    }

    return res.json(results);
  } catch (err) {
    console.error('/debug/users error:', err);
    return res.status(500).json({ error: err.message });
  }
});

/**
 * Debug: list all CRM modules.
 * Use this to find the API name for your bugs module (CustomModule2 in the CRM URL).
 * Look for module where plural_label = "Bugs" or similar.
 * The "api_name" field is what you put in BUGS_MODULE at the top of this file.
 *
 * GET /server/crm-monthly-stats/debug/modules
 */
app.get('/debug/modules', async (req, res) => {
  try {
    const app_cat    = catalyst.initialize(req);
    const authHeader = await getAuthHeader(app_cat);

    const raw = await crmGet(authHeader, '/crm/v3/settings/modules');

    const modules = (raw.modules || []).map(m => ({
      id:           m.id,
      api_name:     m.api_name,
      module_name:  m.module_name,
      plural_label: m.plural_label,
      singular_label: m.singular_label,
      is_custom:    m.generated_type === 'custom'
    }));

    // Highlight custom modules (they're likely your CustomModule2 etc.)
    const customModules = modules.filter(m => m.is_custom);

    return res.json({
      note: 'Find your bugs module in custom_modules. Set BUGS_MODULE in index.js to the api_name value.',
      current_bugs_module: BUGS_MODULE,
      custom_modules: customModules,
      all_modules: modules
    });
  } catch (err) {
    console.error('/debug/modules error:', err);
    return res.status(500).json({ error: err.message });
  }
});

/**
 * Debug: run a raw COQL query and see the full CRM response.
 * GET /server/crm-monthly-stats/debug/coql?q=SELECT+count(id)+FROM+Bugs+WHERE+Owner+%3D+'12345'
 * or POST with JSON body { "query": "SELECT ..." }
 */
app.get('/debug/coql', async (req, res) => {
  try {
    const app_cat    = catalyst.initialize(req);
    const authHeader = await getAuthHeader(app_cat);
    const query      = req.query.q;

    if (!query) {
      return res.status(400).json({
        error: 'Missing query param ?q=',
        example: `/debug/coql?q=${encodeURIComponent(`SELECT count(id) FROM ${BUGS_MODULE} LIMIT 1`)}`
      });
    }

    const body = await crmPost(authHeader, '/crm/v3/coql', { select_query: query });
    return res.json({ query, response: body });
  } catch (err) {
    console.error('/debug/coql error:', err);
    return res.status(500).json({ error: err.message });
  }
});

/**
 * Debug: fetch a sample of records from any module for a given user.
 * GET /server/crm-monthly-stats/debug/sample?module=Bugs&userId=1234567890
 */
app.get('/debug/sample', async (req, res) => {
  try {
    const app_cat    = catalyst.initialize(req);
    const authHeader = await getAuthHeader(app_cat);
    const module     = req.query.module || BUGS_MODULE;
    const userId     = req.query.userId;

    let query = `SELECT id, Owner, Status, Created_Time FROM ${module} LIMIT 5`;
    if (userId) {
      query = `SELECT id, Owner, Status, Created_Time FROM ${module} WHERE Owner = '${userId}' LIMIT 5`;
    }

    const body = await crmPost(authHeader, '/crm/v3/coql', { select_query: query });
    return res.json({ module, userId: userId || 'any', query, response: body });
  } catch (err) {
    console.error('/debug/sample error:', err);
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

    console.log(`[WorkStatus] Fetching team stats for ${monthName}, bugs module=${BUGS_MODULE}`);

    // Resolve user IDs for each team member in parallel
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
    return res.json({ month: monthName, period: { start, end }, bugs_module: BUGS_MODULE, team: teamStats, generated_at: new Date().toISOString() });

  } catch (err) {
    console.error('[WorkStatus] Error:', err);
    return res.status(500).json({ error: err.message });
  }
});

module.exports = app;
