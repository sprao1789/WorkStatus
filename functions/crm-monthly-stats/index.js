/**
 * WorkStatus — CRM Monthly Stats
 * Catalyst Advanced IO Function using Express.js (Node.js 18)
 *
 * Uses Catalyst Connection "zoho_crm_connection" (OAuth, configured in Catalyst console).
 * No hardcoded tokens.
 *
 * Routes:
 *   GET /server/crm-monthly-stats/              → JSON stats
 *   GET /server/crm-monthly-stats/widget        → HTML widget (for Cliq iframe / browser)
 *   GET /server/crm-monthly-stats/healthz       → { ok: true }
 *
 * Optional query params:
 *   ?year=2026&month=7      → fetch stats for a specific month (month is 1-based)
 *   ?format=html            → same as /widget route
 */

'use strict';

const express   = require('express');
const catalyst  = require('zcatalyst-sdk-node');

const app = express();
app.use(express.json());

// Catalyst passes the full path e.g. /server/crm-monthly-stats/widget
// Strip the /server/<function-name> prefix so routes below use clean paths like /widget
app.use((req, _res, next) => {
  const prefix = '/server/crm-monthly-stats';
  if (req.url.startsWith(prefix)) {
    req.url = req.url.slice(prefix.length) || '/';
  }
  next();
});

// ─── Date helpers ─────────────────────────────────────────────────────────────

function getMonthRange(year, month) {
  // month is 0-based (JS Date convention)
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

async function coqlCount(connection, query) {
  try {
    const resp = await connection.post(
      'https://www.zohoapis.in/crm/v3/coql',
      JSON.stringify({ select_query: query }),
      { 'Content-Type': 'application/json' }
    );
    const body = JSON.parse(resp.getBody());
    return (body.data && body.data[0]) ? (body.data[0].count || 0) : 0;
  } catch (e) {
    console.error('COQL error:', e.message);
    return 0;
  }
}

async function getTopOpenDeals(connection) {
  try {
    const url = 'https://www.zohoapis.in/crm/v3/Deals' +
      '?fields=Deal_Name,Stage,Amount,Account_Name,Closing_Date' +
      '&criteria=(Stage:not_equal_to:Closed Won;and:Stage:not_equal_to:Closed Lost)' +
      '&sort_by=Amount&sort_order=desc&per_page=5';
    const resp = await connection.get(url);
    const body = JSON.parse(resp.getBody());
    return (body.data || []).map(d => ({
      name:    d.Deal_Name || 'Unnamed',
      stage:   d.Stage || 'Unknown',
      amount:  d.Amount || 0,
      account: d.Account_Name ? d.Account_Name.name : 'N/A',
      closing: d.Closing_Date || '—'
    }));
  } catch (e) {
    console.error('Top deals error:', e.message);
    return [];
  }
}

async function fetchStats(connection, start, end) {
  const tz   = '+05:30';
  const from = `${start}T00:00:00${tz}`;
  const to   = `${end}T23:59:59${tz}`;

  const [
    dealsCreated, dealsWon, dealsLost,
    contacts, leads,
    tasks, calls,
    topDeals
  ] = await Promise.all([
    coqlCount(connection, `SELECT count(id) as count FROM Deals WHERE Created_Time >= '${from}' AND Created_Time <= '${to}'`),
    coqlCount(connection, `SELECT count(id) as count FROM Deals WHERE Stage = 'Closed Won' AND Closing_Date >= '${start}' AND Closing_Date <= '${end}'`),
    coqlCount(connection, `SELECT count(id) as count FROM Deals WHERE Stage = 'Closed Lost' AND Closing_Date >= '${start}' AND Closing_Date <= '${end}'`),
    coqlCount(connection, `SELECT count(id) as count FROM Contacts WHERE Created_Time >= '${from}' AND Created_Time <= '${to}'`),
    coqlCount(connection, `SELECT count(id) as count FROM Leads WHERE Created_Time >= '${from}' AND Created_Time <= '${to}'`),
    coqlCount(connection, `SELECT count(id) as count FROM Tasks WHERE Status = 'Completed' AND Modified_Time >= '${from}' AND Modified_Time <= '${to}'`),
    coqlCount(connection, `SELECT count(id) as count FROM Calls WHERE Created_Time >= '${from}' AND Created_Time <= '${to}'`),
    getTopOpenDeals(connection)
  ]);

  const totalClosed = dealsWon + dealsLost;
  return {
    deals_created:   dealsCreated,
    deals_won:       dealsWon,
    deals_lost:      dealsLost,
    win_rate:        totalClosed > 0 ? Math.round((dealsWon / totalClosed) * 100) : 0,
    contacts_added:  contacts,
    leads_added:     leads,
    tasks_completed: tasks,
    calls_made:      calls,
    top_open_deals:  topDeals
  };
}

// ─── HTML Widget Template ──────────────────────────────────────────────────────

function buildWidgetHTML(monthName, stats) {
  const fmt      = n => Number(n).toLocaleString('en-IN');
  const dealRows = stats.top_open_deals.map(d => `
    <tr>
      <td>${d.name}</td>
      <td><span class="badge">${d.stage}</span></td>
      <td>${d.account}</td>
      <td class="amount">₹${fmt(d.amount)}</td>
      <td>${d.closing}</td>
    </tr>`).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>WorkStatus — ${monthName}</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f4f6fb;color:#222}
  .card{background:#fff;border-radius:14px;box-shadow:0 4px 24px rgba(0,0,0,.09);max-width:800px;margin:24px auto;overflow:hidden}
  .header{background:linear-gradient(135deg,#e03131,#9b2226);color:#fff;padding:22px 28px}
  .header h1{font-size:20px;font-weight:700}
  .header p{font-size:13px;opacity:.82;margin-top:3px}
  .section{padding:20px 28px;border-bottom:1px solid #f0f0f0}
  .section-title{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.8px;color:#888;margin-bottom:14px}
  .grid{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}
  .stat{background:#f8f9fd;border:1px solid #e8eaf2;border-radius:10px;padding:16px 10px;text-align:center}
  .stat .icon{font-size:20px}
  .stat .val{font-size:28px;font-weight:800;color:#e03131;margin:4px 0 2px}
  .stat .lbl{font-size:10px;color:#999;font-weight:600;text-transform:uppercase}
  table{width:100%;border-collapse:collapse;font-size:13px}
  th{background:#f4f5f9;padding:9px 12px;text-align:left;font-size:11px;font-weight:600;color:#777;text-transform:uppercase}
  td{padding:10px 12px;border-bottom:1px solid #f2f2f2;color:#333}
  tr:last-child td{border-bottom:none}
  tr:hover td{background:#fafbff}
  .badge{background:#e8f0fe;color:#1a56db;border-radius:20px;padding:2px 9px;font-size:11px;font-weight:600;white-space:nowrap}
  .amount{font-weight:700;color:#1a7c3e}
  .footer{padding:14px 28px;background:#fafbfc;display:flex;justify-content:space-between;align-items:center}
  .footer span{font-size:12px;color:#bbb}
  .btn{padding:8px 16px;border-radius:8px;font-size:13px;font-weight:600;border:none;cursor:pointer;text-decoration:none;display:inline-block}
  .btn-primary{background:#e03131;color:#fff;margin-left:8px}
  .btn-secondary{background:#f0f2f8;color:#333}
  @media(max-width:600px){.grid{grid-template-columns:repeat(2,1fr)}}
</style>
</head>
<body>
<div class="card">
  <div class="header">
    <h1>📊 WorkStatus — Monthly CRM Stats</h1>
    <p>${monthName} &nbsp;·&nbsp; CRM Performance Overview</p>
  </div>
  <div class="section">
    <div class="section-title">📈 Deals Summary</div>
    <div class="grid">
      <div class="stat"><div class="icon">🎯</div><div class="val">${stats.deals_created}</div><div class="lbl">Created</div></div>
      <div class="stat"><div class="icon">🏆</div><div class="val">${stats.deals_won}</div><div class="lbl">Won</div></div>
      <div class="stat"><div class="icon">❌</div><div class="val">${stats.deals_lost}</div><div class="lbl">Lost</div></div>
      <div class="stat"><div class="icon">📊</div><div class="val">${stats.win_rate}%</div><div class="lbl">Win Rate</div></div>
    </div>
  </div>
  <div class="section">
    <div class="section-title">👥 Pipeline Activity</div>
    <div class="grid">
      <div class="stat"><div class="icon">🙋</div><div class="val">${stats.contacts_added}</div><div class="lbl">Contacts</div></div>
      <div class="stat"><div class="icon">💡</div><div class="val">${stats.leads_added}</div><div class="lbl">Leads</div></div>
      <div class="stat"><div class="icon">✅</div><div class="val">${stats.tasks_completed}</div><div class="lbl">Tasks Done</div></div>
      <div class="stat"><div class="icon">📞</div><div class="val">${stats.calls_made}</div><div class="lbl">Calls</div></div>
    </div>
  </div>
  <div class="section">
    <div class="section-title">💼 Top Open Deals</div>
    ${stats.top_open_deals.length > 0 ? `
    <table>
      <thead><tr><th>Deal Name</th><th>Stage</th><th>Account</th><th>Amount</th><th>Closing</th></tr></thead>
      <tbody>${dealRows}</tbody>
    </table>` : '<p style="color:#aaa;font-size:13px">No open deals found.</p>'}
  </div>
  <div class="footer">
    <span>Updated: ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST</span>
    <div>
      <a href="javascript:location.reload()" class="btn btn-secondary">🔄 Refresh</a>
      <a href="https://crm.zoho.in/crm/crmlaunchpad/tab/Home/begin" target="_blank" class="btn btn-primary">🌐 Open CRM</a>
    </div>
  </div>
</div>
</body>
</html>`;
}

// ─── Routes ───────────────────────────────────────────────────────────────────

// Health check
app.get('/healthz', (req, res) => {
  res.json({ ok: true, service: 'WorkStatus CRM Stats', ts: new Date().toISOString() });
});

// Main stats handler (JSON + HTML)
app.get(['/', '/widget'], async (req, res) => {
  try {
    const app_cat = catalyst.initialize(req);

    const now        = new Date();
    const year       = parseInt(req.query.year  || now.getFullYear(), 10);
    const monthParam = parseInt(req.query.month || (now.getMonth() + 1), 10);
    const { start, end, monthName } = getMonthRange(year, monthParam - 1);

    const wantHTML = req.query.format === 'html' || req.path.endsWith('/widget');

    // Get the Catalyst Connection — must be created in Catalyst console first
    const connection = app_cat.connection('zoho_crm_connection');

    console.log(`[WorkStatus] Fetching stats for ${monthName} (${start} → ${end})`);
    const stats = await fetchStats(connection, start, end);

    if (wantHTML) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store, max-age=0');
      return res.send(buildWidgetHTML(monthName, stats));
    }

    res.setHeader('Cache-Control', 'no-store, max-age=0');
    return res.json({
      month:        monthName,
      period:       { start, end },
      summary:      stats,
      generated_at: new Date().toISOString()
    });

  } catch (err) {
    console.error('[WorkStatus] Error:', err);
    return res.status(500).json({ error: err.message });
  }
});

// ─── Export for Catalyst ───────────────────────────────────────────────────────
module.exports = app;
