#!/usr/bin/env node
'use strict';

/*
 * netmon.js — Internet connectivity monitor (ping + DNS) with a live TUI.
 * Zero dependencies, Node.js only.
 *
 * Checks once per second:
 *   1. ICMP ping to a public IP (default 8.8.8.8)
 *   2. DNS lookup of a domain (default google.com)
 * The connection is "up" only when BOTH succeed.
 *
 * Writes a full-resolution CSV (one row per check) and shows a live
 * htop/lazygit-style dashboard in the terminal.
 */

const { execFile } = require('node:child_process');
const dnsPromises = require('node:dns').promises;
const fs = require('node:fs');
const path = require('node:path');

// ---- defaults ------------------------------------------------------------
const PING_HOST = '8.8.8.8';
const DNS_HOST = 'google.com';
const INTERVAL_MS = 1000;       // one check per second
const PING_TIMEOUT_MS = 900;    // ping command timeout (ms)
const DNS_TIMEOUT_MS = 1000;    // dns lookup timeout (ms)
const HISTORY_MAX = 360;        // samples kept in memory (for the graph)

// ---- ansi helpers --------------------------------------------------------
const R = '\x1b[0m';
const bold = (s) => `\x1b[1m${s}${R}`;
const red = (s) => `\x1b[31m${s}${R}`;
const green = (s) => `\x1b[32m${s}${R}`;
const gray = (s) => `\x1b[90m${s}${R}`;
const cyan = (s) => `\x1b[36m${s}${R}`;

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const hr = (w) => gray('\u2500'.repeat(w));
const hms = (d) => d.toTimeString().slice(0, 8);

function fmtDur(ms) {
  if (ms == null || ms < 0) return '\u2014';
  const s = ms / 1000;
  if (s < 60) return s.toFixed(1) + 's';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${Math.floor(s % 60)}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

// ---- argument parsing ----------------------------------------------------
function parseArgs(argv) {
  const opts = { plain: false, host: PING_HOST, domain: DNS_HOST, interval: INTERVAL_MS, out: null, max: 0 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--plain') opts.plain = true;
    else if (a === '--host' && argv[i + 1]) opts.host = argv[++i];
    else if (a === '--domain' && argv[i + 1]) opts.domain = argv[++i];
    else if (a === '--interval' && argv[i + 1]) opts.interval = Math.max(500, parseInt(argv[++i], 10) || INTERVAL_MS);
    else if (a === '--out' && argv[i + 1]) opts.out = argv[++i];
    else if (a === '--max' && argv[i + 1]) opts.max = Math.max(1, parseInt(argv[++i], 10) || 0);
    else if (a === '--help' || a === '-h') { printHelp(); process.exit(0); }
  }
  return opts;
}

function printHelp() {
  console.log([
    'Usage: node netmon.js [options]',
    '',
    '  --plain                no TUI; print state changes + heartbeat',
    '  --host <ip>            ping target      (default 8.8.8.8)',
    '  --domain <d>           dns lookup target(default google.com)',
    '  --interval <ms>        check interval   (default 1000)',
    '  --out <file.csv>       custom CSV path',
    '  --max <n>              stop after n checks (for testing)',
    '  -h, --help             show this help',
  ].join('\n'));
}

const cfg = parseArgs(process.argv.slice(2));

// ---- checks --------------------------------------------------------------
function pingHost(host, timeoutMs) {
  return new Promise((resolve) => {
    const args = process.platform === 'win32'
      ? ['-n', '1', '-w', String(timeoutMs), host]
      : ['-c', '1', '-W', String(Math.ceil(timeoutMs / 1000)), host];
    const t0 = process.hrtime.bigint();
    execFile('ping', args, { timeout: timeoutMs + 1000, windowsHide: true }, (err, stdout) => {
      const wallMs = Number(process.hrtime.bigint() - t0) / 1e6;
      if (err) return resolve({ ok: false, ms: null });
      const m = /time[=<]([0-9.]+)\s*ms/i.exec(stdout || '');
      return resolve({ ok: true, ms: m ? parseFloat(m[1]) : Math.round(wallMs) });
    });
  });
}

function dnsCheck(host, timeoutMs) {
  return new Promise((resolve) => {
    const t0 = process.hrtime.bigint();
    let settled = false;
    const timer = setTimeout(() => { if (!settled) { settled = true; resolve({ ok: false, ms: null }); } }, timeoutMs);
    dnsPromises.lookup(host, { family: 4 })
      .then(() => {
        if (settled) return;
        settled = true; clearTimeout(timer);
        resolve({ ok: true, ms: Math.round(Number(process.hrtime.bigint() - t0) / 1e6) });
      })
      .catch(() => {
        if (settled) return;
        settled = true; clearTimeout(timer);
        resolve({ ok: false, ms: null });
      });
  });
}

// ---- state ---------------------------------------------------------------
const state = {
  up: true,
  checks: 0,
  ups: 0,
  downs: 0,
  outageCount: 0,
  lastChange: Date.now(),
  currentOutageStart: null,
  longestDownMs: 0,
  lastPingMs: null,
  lastDnsMs: null,
  events: [],   // { t: Date, dir: 'UP'|'DOWN', note: string }
  history: [],  // booleans (true = up), newest last
};

// ---- CSV -----------------------------------------------------------------
function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
function csvCell(v) {
  const s = String(v == null ? '' : v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

const csvFile = cfg.out || path.join(process.cwd(), `netmon_${stamp()}.csv`);
const csv = fs.createWriteStream(csvFile, { flags: 'a' });
csv.write('timestamp,status,ping_ms,dns_ms,note\n');

// ---- rendering (TUI) -----------------------------------------------------
function render() {
  const w = clamp(process.stdout.columns || 80, 50, 200);
  const now = Date.now();
  const pct = state.checks ? (state.ups / state.checks * 100).toFixed(1) : '\u2014';
  const stateDur = now - state.lastChange;

  const L = [];
  L.push(bold(cyan('netmon')) + gray(' \u2014 internet connectivity monitor (ping + dns)'));
  L.push(hr(w));

  const status = state.up
    ? `${green('\u25cf')} ${bold(green('ONLINE'))}`
    : `${red('\u25cf')} ${bold(red('OFFLINE'))}`;
  L.push(`  Status   ${status}`);
  L.push(`  Uptime   ${pct}%   Outages ${state.outageCount}`);
  L.push(`  Checks   ${state.checks}   ${state.up ? 'up for' : 'down for'} ${fmtDur(stateDur)}`);

  const pingTxt = state.lastPingMs == null ? gray('\u2014') : `${state.lastPingMs} ms`;
  const dnsTxt = state.lastDnsMs == null ? gray('\u2014') : `${state.lastDnsMs} ms`;
  L.push(`  Latency  ping ${pingTxt}   dns ${dnsTxt}`);
  L.push(`  Longest outage  ${fmtDur(state.longestDownMs)}`);
  L.push(hr(w));

  const cols = w - 2;
  const show = state.history.slice(-cols);
  L.push(`  ${show.map((b) => (b ? green('\u2588') : red('\u2588'))).join('')}`);
  L.push(gray(`  \u2514 last ${show.length}s   (${green('\u2588')} up \u00b7 ${red('\u2588')} down)`));
  L.push(hr(w));

  L.push(gray('  Events'));
  const ev = state.events.slice(-8);
  if (ev.length === 0) L.push(gray('  (no events yet)'));
  for (const e of ev) {
    const sym = e.dir === 'DOWN' ? red('\u25bc') : green('\u25b2');
    const label = e.dir === 'DOWN' ? red('DOWN') : green('UP');
    L.push(`  ${hms(e.t)}  ${sym} ${label}  ${gray(e.note)}`);
  }
  L.push(hr(w));
  L.push(gray(`  [q] quit \u00b7 [Ctrl+C] quit    CSV: ${path.basename(csvFile)}`));

  process.stdout.write('\x1b[2J\x1b[H' + L.join('\n') + '\n');
}

// ---- main loop -----------------------------------------------------------
let running = true;
let timer = null;

async function tick() {
  if (!running) return;

  const [ping, dnsR] = await Promise.all([
    pingHost(cfg.host, PING_TIMEOUT_MS),
    dnsCheck(cfg.domain, DNS_TIMEOUT_MS),
  ]);
  if (!running) return;

  const up = ping.ok && dnsR.ok;
  const now = new Date();

  state.checks++;
  if (up) state.ups++; else state.downs++;
  state.lastPingMs = ping.ms;
  state.lastDnsMs = dnsR.ms;

  let note = '';
  if (!up) {
    note = (!ping.ok && !dnsR.ok) ? 'ping + dns failed' : (!ping.ok ? 'ping failed' : 'dns failed');
  }

  if (up !== state.up) {
    state.up = up;
    state.lastChange = now.getTime();
    if (!up) {
      state.outageCount++;
      state.currentOutageStart = now.getTime();
      state.events.push({ t: now, dir: 'DOWN', note });
    } else {
      const dur = now.getTime() - (state.currentOutageStart || now.getTime());
      if (dur > state.longestDownMs) state.longestDownMs = dur;
      state.currentOutageStart = null;
      state.events.push({ t: now, dir: 'UP', note: '' });
    }
  }

  state.history.push(up);
  if (state.history.length > HISTORY_MAX) state.history.shift();

  csv.write(`${now.toISOString()},${up ? 'UP' : 'DOWN'},${ping.ms == null ? '' : ping.ms},${dnsR.ms == null ? '' : dnsR.ms},${csvCell(note)}\n`);

  if (tui) {
    render();
  } else {
    const lastEvent = state.events[state.events.length - 1];
    if (lastEvent && lastEvent.t === now) {
      console.log(`[${hms(now)}] ${lastEvent.dir === 'DOWN' ? 'DOWN' : 'UP  '}  ${lastEvent.note}`);
    }
    if (state.checks % 60 === 0) {
      console.log(`[${hms(now)}] heartbeat  checks=${state.checks}  up=${(state.ups / state.checks * 100).toFixed(1)}%`);
    }
  }

  if (cfg.max && state.checks >= cfg.max) return shutdown();

  timer = setTimeout(tick, cfg.interval);
}

// ---- lifecycle -----------------------------------------------------------
function shutdown() {
  if (!running) return;
  running = false;
  if (timer) clearTimeout(timer);
  csv.end();
  if (tui) process.stdout.write('\x1b[?25h\x1b[2J\x1b[H');

  const pct = state.checks ? (state.ups / state.checks * 100).toFixed(1) : '0.0';
  console.log(gray('\u2500\u2500 netmon summary \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500'));
  console.log(`checks: ${state.checks}   up: ${state.ups}   down: ${state.downs}`);
  console.log(`uptime: ${pct}%   outages: ${state.outageCount}   longest outage: ${fmtDur(state.longestDownMs)}`);
  console.log(`saved to: ${csvFile}`);
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// ---- startup -------------------------------------------------------------
const tui = !cfg.plain && Boolean(process.stdout.isTTY) && Boolean(process.stdin.isTTY);

if (require.main === module) {
  if (tui) {
    process.stdout.write('\x1b[?25l');
    if (process.stdin.setRawMode) process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (k) => {
      if (k === '\u0003' || k === 'q' || k === 'Q') shutdown();
    });
    render();
  } else {
    console.log(`netmon: ping ${cfg.host} + dns ${cfg.domain} every ${cfg.interval}ms`);
    console.log(`saving to: ${csvFile}`);
  }
  tick();
}

module.exports = { render, state, fmtDur };
