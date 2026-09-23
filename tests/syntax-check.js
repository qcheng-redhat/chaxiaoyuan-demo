#!/usr/bin/env node
/* Static syntax check - no dependencies, no browser, no server.
 *
 * Why this exists: most of this app's client logic lives in inline <script>
 * blocks inside the four HTML files. Nothing else parses those - the API tests
 * only load server.js, and Playwright only exercises the paths a test happens
 * to walk. A stray brace in an inline script would pass every test and break
 * the page in production. This script closes that hole in a few hundred
 * milliseconds.
 *
 * Two checks:
 *   1. every .js file is parsed by `node --check` (Node's own parser);
 *   2. every inline <script> block in every .html file is parsed with vm.Script,
 *      with lineOffset set so reported line numbers match the HTML file.
 *
 * Exit code 0 = clean, 1 = at least one syntax error.
 * Usage: npm run check:syntax   (or: node tests/syntax-check.js)
 */

'use strict';

var fs = require('fs');
var path = require('path');
var vm = require('vm');
var cp = require('child_process');

var ROOT = path.resolve(__dirname, '..');

// Never walk into these: dependencies, VCS, test output, runtime data, docs.
var SKIP_DIRS = [
  'node_modules',
  '.git',
  '.playwright-data',
  'test-results',
  'data',
  '.workbuddy'
];

function walk(dir, out) {
  var entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return out;
  }
  for (var i = 0; i < entries.length; i++) {
    var e = entries[i];
    if (e.isDirectory()) {
      if (SKIP_DIRS.indexOf(e.name) !== -1) continue;
      walk(path.join(dir, e.name), out);
    } else {
      out.push(path.join(dir, e.name));
    }
  }
  return out;
}

function rel(p) {
  return path.relative(ROOT, p).split(path.sep).join('/');
}

/* ---------- check 1: plain .js files via `node --check` ---------- */

function checkJsFile(file, failures) {
  var r = cp.spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (r.status !== 0) {
    var text = ((r.stderr || '') + (r.stdout || '')).trim();
    failures.push({ file: rel(file), label: 'node --check', detail: text });
    return false;
  }
  return true;
}

/* ---------- check 2: inline <script> blocks inside .html files ---------- */

// `<script ...>` up to its close. Like an HTML tokenizer, we must skip over a
// whole block before looking for the next opening tag: `orders.html` embeds a
// literal `<script>` inside a JS string (the receipt popup HTML, closed as
// `<\/script>`), which a browser never treats as a tag but a naive regex does.
var SCRIPT_RE = /<script([^>]*)>/gi;
var SCRIPT_CLOSE = '</script>';
var SCRIPT_CLOSE_LEN = SCRIPT_CLOSE.length;

function checkHtmlFile(file, failures) {
  var html = fs.readFileSync(file, 'utf8');
  var name = rel(file);
  var count = 0;
  var ok = true;
  var m;

  SCRIPT_RE.lastIndex = 0;
  while ((m = SCRIPT_RE.exec(html)) !== null) {
    var attrs = m[1] || '';
    var contentStart = m.index + m[0].length;
    var close = html.indexOf(SCRIPT_CLOSE, contentStart);

    // Advance past this whole block (or past the tag when it is unclosed), so
    // that text inside a script body is never mistaken for markup.
    SCRIPT_RE.lastIndex = close === -1 ? contentStart : close + SCRIPT_CLOSE_LEN;

    if (/\bsrc\s*=/i.test(attrs)) continue;
    if (/type\s*=\s*["']?(?!text\/javascript|module)/i.test(attrs)) continue;

    if (close === -1) {
      failures.push({
        file: name,
        label: 'unterminated <script> tag',
        detail: 'opened at line ' + (html.slice(0, m.index).split('\n').length)
      });
      ok = false;
      continue;
    }

    var body = html.slice(contentStart, close);
    count++;
    if (!body.trim()) continue;

    // Line 1 of the body sits on the same line as the opening tag's '>'.
    var startLine = html.slice(0, contentStart).split('\n').length;
    try {
      new vm.Script(body, { filename: name, lineOffset: startLine - 1 });
    } catch (err) {
      var stack = String((err && err.stack) || err);
      failures.push({
        file: name,
        label: '<script> #' + count + ' (starts at line ' + startLine + ')',
        detail: stack.split('\n').slice(0, 6).join('\n')
      });
      ok = false;
    }
  }

  return { ok: ok, scripts: count };
}

/* ---------- run ---------- */

function main() {
  var files = walk(ROOT, []);
  var jsFiles = files.filter(function (f) { return f.endsWith('.js'); }).sort();
  var htmlFiles = files.filter(function (f) { return f.endsWith('.html'); }).sort();

  var failures = [];
  var jsOk = 0;
  jsFiles.forEach(function (f) { if (checkJsFile(f, failures)) jsOk++; });

  var htmlScripts = 0;
  htmlFiles.forEach(function (f) {
    var r = checkHtmlFile(f, failures);
    if (r.ok) htmlScripts += r.scripts;
  });

  console.log('syntax check: ' + jsFiles.length + ' .js files, ' + htmlFiles.length +
    ' .html files (' + htmlScripts + ' inline scripts)');

  if (failures.length) {
    console.log('');
    console.log('SYNTAX ERRORS (' + failures.length + '):');
    failures.forEach(function (f) {
      console.log('');
      console.log('  FAIL ' + f.file + '  [' + f.label + ']');
      f.detail.split('\n').forEach(function (line) {
        console.log('    ' + line);
      });
    });
    console.log('');
    console.log('SYNTAX CHECK: FAIL');
    process.exit(1);
  }

  console.log('  .js parsed ok           : ' + jsOk + '/' + jsFiles.length);
  console.log('  inline scripts parsed ok: ' + htmlScripts);
  console.log('');
  console.log('SYNTAX CHECK: PASS');
}

main();
