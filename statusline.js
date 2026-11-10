#!/usr/bin/env node
// Claude Code Statusline
// Row 1: model | directory + branch + git state | context usage
// Row 2: effort | rate limits

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

let input = '';
const stdinTimeout = setTimeout(() => process.exit(0), 3000);
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => {
  clearTimeout(stdinTimeout);
  try {
    const data = JSON.parse(input);
    const shortModel = (name) => {
      const m = name.match(/^(?:claude-)?(Opus|Sonnet|Haiku|Mythos)[\s-]+(\d+(?:[.-]\d+)?)(?:\s*\(([^)]+)\))?/i);
      if (!m) return name;
      const family = m[1].charAt(0).toUpperCase() + m[1].charAt(1).toLowerCase();
      const version = m[2].replace('-', '.');
      const ctx = m[3];
      let suffix = `${family} ${version}`;
      if (ctx) {
        const ctxMatch = ctx.match(/(\d+)\s*([KMG])/i);
        if (ctxMatch) suffix += ` (${ctxMatch[1]}${ctxMatch[2].toLowerCase()})`;
      }
      return suffix;
    };
    const model = shortModel(data.model?.display_name || 'Claude');
    const dir = data.workspace?.current_dir || process.cwd();
    const session = data.session_id || '';
    const rawRemaining = data.context_window?.remaining_percentage;
    const remaining = (rawRemaining == null || rawRemaining === '') ? NaN : Number(rawRemaining);

    const fmt = (n) => {
      if (n < 1000) return String(n);
      if (n < 10000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
      if (n < 1000000) return Math.round(n / 1000) + 'k';
      return (n / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
    };

    // --- Context window ---
    let ctx = '';
    if (Number.isFinite(remaining)) {
      // Absolute token counts (e.g. "480k/1M"). Numerator is total_input_tokens
      // (input + cache_creation + cache_read); denominator is context_window_size.
      // When both are present we drive the bar from them directly \u2014 more honest
      // than remapping `remaining_percentage` through a hardcoded compact buffer
      // that doesn't scale across context window sizes.
      const totalInput = Number(data.context_window?.total_input_tokens) || 0;
      const ctxSize = Number(data.context_window?.context_window_size) || 0;
      const haveAbs = totalInput > 0 && ctxSize > 0;
      const used = haveAbs
        ? Math.max(0, Math.min(100, Math.round((totalInput / ctxSize) * 100)))
        : Math.max(0, Math.min(100, Math.round(100 - remaining)));

      // Bridge file for context-monitor PostToolUse hook
      if (session) {
        try {
          const bridgePath = path.join(os.tmpdir(), `claude-ctx-${session}.json`);
          fs.writeFileSync(bridgePath, JSON.stringify({
            session_id: session,
            remaining_percentage: remaining,
            used_pct: used,
            timestamp: Math.floor(Date.now() / 1000)
          }));
        } catch (e) {}
      }

      const steps = Math.max(0, Math.min(10, Math.floor(used / 10)));
      let bar = '';
      for (let i = 0; i < 5; i++) {
        const cell = Math.max(0, Math.min(2, steps - i * 2));
        bar += cell === 2 ? '\u2588' : cell === 1 ? '\u258c' : '\u2591';
      }

      const abs = haveAbs ? ` ${fmt(totalInput)}/${fmt(ctxSize)}` : '';

      let color, prefix = '';
      if (used < 50) color = '\x1b[38;2;255;125;218m';
      else if (used < 65) color = '\x1b[33m';
      else if (used < 80) color = '\x1b[38;2;255;140;0m';
      else { color = '\x1b[31m'; prefix = '\uD83D\uDC80 '; }

      // Absolute token cap: 250k is the pricing/quality cliff regardless of how
      // wide the context window is. Bump pink \u2192 yellow once we cross it, so a
      // 1M session at 250k/1M (25% used) doesn't render as "still cozy pink".
      if (haveAbs && totalInput >= 250000 && color === '\x1b[38;2;255;125;218m') {
        color = '\x1b[33m';
      }

      ctx = ` ${color}${prefix}${bar}${abs}\x1b[0m`;
    }

    // --- Git status (live, local, no network) ---
    let gitInfo = '';
    let branch = '';
    let detachedSha = '';
    try {
      const gitExec = (args) => {
        try {
          return execFileSync('git', args, { encoding: 'utf8', cwd: dir, windowsHide: true, timeout: 1000, stdio: ['pipe', 'pipe', 'ignore'] }).trim();
        } catch (e) { return null; }
      };
      const parts = [];

      // Uncommitted changes — bucketed by VS Code-style status codes
      const status = gitExec(['status', '--porcelain']);
      if (status) {
        const buckets = { M: 0, A: 0, D: 0, R: 0, '?': 0, '!': 0 };
        for (const line of status.split('\n')) {
          if (!line) continue;
          const X = line.charAt(0);
          const Y = line.charAt(1);
          if (X === '?' && Y === '?') buckets['?']++;
          else if (X === 'U' || Y === 'U' || (X === 'D' && Y === 'D') || (X === 'A' && Y === 'A')) buckets['!']++;
          else if (Y === 'D' || X === 'D') buckets.D++;
          else if (X === 'R') buckets.R++;
          else if (X === 'A' || X === 'C') buckets.A++;
          else buckets.M++;
        }
        const dimBuckets = [];
        for (const k of ['M', 'A', 'D', 'R', '?']) {
          if (buckets[k] > 0) dimBuckets.push(`${buckets[k]}${k}`);
        }
        if (dimBuckets.length > 0) parts.push(`\x1b[2m${dimBuckets.join(' ')}\x1b[0m`);
        if (buckets['!'] > 0) parts.push(`\x1b[31m${buckets['!']}!\x1b[0m`);
      }

      // Behind/ahead origin
      branch = gitExec(['branch', '--show-current']) || '';
      if (!branch) {
        detachedSha = gitExec(['rev-parse', '--short', 'HEAD']) || '';
      }
      if (branch) {
        const remoteRef = `refs/remotes/origin/${branch}`;
        const behind = parseInt(gitExec(['rev-list', '--count', `HEAD..${remoteRef}`]) || '0', 10);
        const ahead = parseInt(gitExec(['rev-list', '--count', `${remoteRef}..HEAD`]) || '0', 10);
        if (behind > 0) parts.push(`\x1b[31m\u2193${behind} pull\x1b[0m`);
        if (ahead > 0) parts.push(`\x1b[33m\u2191${ahead} push\x1b[0m`);
      }

      // MD sync check: drift between CLAUDE.md ↔ AGENTS.md ↔ GEMINI.md
      try {
        const claudeMd = path.join(dir, 'CLAUDE.md');
        const agentsMd = path.join(dir, 'AGENTS.md');
        const geminiMd = path.join(dir, 'GEMINI.md');
        if (fs.existsSync(claudeMd) && fs.existsSync(agentsMd) && fs.existsSync(geminiMd)) {
          const SYNC_LINE_RE = /^> \*\*(?:Синхронизация|Sync):\*\*.*$/m;
          const norm = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
          const cs = norm(claudeMd).replace(SYNC_LINE_RE, '');
          const as = norm(agentsMd).replace(SYNC_LINE_RE, '');
          const gs = norm(geminiMd).replace(SYNC_LINE_RE, '');
          if (cs !== as || cs !== gs) {
            parts.push('\x1b[31m\u26A0 md drift\x1b[0m');
          }
        }
      } catch (e) {}

      if (parts.length > 0) {
        gitInfo = ' ' + parts.join(' ');
      }
    } catch (e) {}

    // --- Rate limits (subscription) ---
    const limitParts = [];
    const rl = data.rate_limits;
    if (rl) {
      const colorPct = (pct) => {
        if (pct < 50) return `\x1b[38;2;255;125;218m${pct}%\x1b[0m`;
        if (pct < 65) return `\x1b[33m${pct}%\x1b[0m`;
        if (pct < 80) return `\x1b[38;2;255;140;0m${pct}%\x1b[0m`;
        return `\x1b[31m${pct}%\x1b[0m`;
      };
      const formatReset = (resetTs, opts) => {
        if (!Number.isFinite(resetTs)) return null;
        const coarse = !!(opts && opts.coarse);
        const resetMin = Math.max(0, Math.ceil((resetTs * 1000 - Date.now()) / 60000));
        if (resetMin >= 1440) {
          const d = Math.floor(resetMin / 1440);
          const h = Math.floor((resetMin % 1440) / 60);
          if (coarse && d >= 2) return `${d}d`;
          if (d === 1 && h === 0) return '24h';
          return `${d}d${h}h`;
        }
        if (resetMin >= 60) {
          const h = Math.floor(resetMin / 60);
          const m = resetMin % 60;
          return m > 0 ? `${h}h${m}m` : `${h}h`;
        }
        return `${resetMin}m`;
      };
      const withReset = (label, bucket, opts) => {
        const rawUsedPct = bucket.used_percentage;
        const usedPct = (rawUsedPct == null || rawUsedPct === '') ? NaN : Number(rawUsedPct);
        if (!Number.isFinite(usedPct)) return null;
        const pct = Math.round(usedPct);
        const reset = formatReset(bucket.resets_at, opts);
        const main = `${label}:${colorPct(pct)}`;
        return reset ? `${main}\x1b[2m(${reset})\x1b[0m` : main;
      };
      const parts = [];
      if (rl.five_hour) {
        const p = withReset('5h', rl.five_hour);
        if (p) parts.push(p);
      }
      if (rl.seven_day) {
        const p = withReset('7d', rl.seven_day, { coarse: true });
        if (p) parts.push(p);
      }
      for (const p of parts) limitParts.push(p);
    }

    // --- Reasoning effort ---
    // stdin carries `effort.level` only for models that support effort.
    let effortSeg = '';
    const effortLevel = data.effort?.level;
    if (typeof effortLevel === 'string' && effortLevel) {
      const effortColors = {
        low: '\x1b[2m',
        medium: '\x1b[36m',
        high: '\x1b[1;36m',
        xhigh: '\x1b[1;35m',
        max: '\x1b[1;31m'
      };
      const color = effortColors[effortLevel] || '\x1b[2m';
      effortSeg = `\x1b[2meffort:\x1b[0m${color}${effortLevel}\x1b[0m`;
    }

    // --- Output ---
    const dirRaw = path.basename(dir);
    const dirShort = dirRaw.length > 15
      ? dirRaw.slice(0, 7) + '…' + dirRaw.slice(-7)
      : dirRaw;
    const buildDirSegment = (name) => {
      let s = `\x1b[2m${name}\x1b[0m`;
      if (branch) s += ` \x1b[36m(${branch})\x1b[0m`;
      else if (detachedSha) s += ` \x1b[31m(HEAD@${detachedSha})\x1b[0m`;
      if (gitInfo) s += gitInfo;
      return s;
    };
    const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
    const sep = ' \x1b[2m\u2502\x1b[0m ';

    // Row 1: model \u2502 dir+branch \u2502 context
    let dirSeg = buildDirSegment(dirRaw);
    const row1Parts = [`\x1b[2m${model}\x1b[0m`, dirSeg, ctx ? ctx.trim() : null].filter(Boolean);
    if (dirRaw !== dirShort) {
      let vis = -sep.replace(/\x1b\[[0-9;]*m/g, '').length;
      for (const s of row1Parts) vis += stripAnsi(sep).length + stripAnsi(s).length;
      if (vis > 80) {
        row1Parts[1] = buildDirSegment(dirShort);
      }
    }
    const row1 = row1Parts.join(sep);

    // Row 2: effort │ rate limits (each omitted when absent)
    const row2Parts = [effortSeg, ...limitParts].filter(Boolean);
    const row2 = row2Parts.join(sep);

    const lines = [row1, row2].filter(Boolean);
    process.stdout.write(lines.join('\n'));
  } catch (e) {}
});
