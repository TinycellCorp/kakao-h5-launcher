#!/usr/bin/env node
/**
 * 카카오 H5 로컬 뷰어 — GameCode 하나로 모든 게임을 웹에서 연다. (zero-dependency)
 *
 * 사용:
 *   node local-serve.js            # https://127.0.0.1:5500/ 에서 게임 목록
 *   node local-serve.js --http     # 인증서 없이 http 로 (경고창 없음, 권장)
 *
 * 접속:
 *   http://127.0.0.1:5500/                 게임 목록(빌드된 것만 표시)
 *   http://127.0.0.1:5500/<GameCode>/      해당 게임 실행
 *
 * ⚠ 127.0.0.1 로 접속하면 게임이 **비카카오(standalone)** 로 뜬다 —
 *   카카오 로그인이 필요 없어 9999 가 나지 않는다. 대신 로그·랭킹·공유는 no-op.
 *   그쪽 확인은 런처의 테스트 진입 링크(gameplay.kakao.com/entry/test/games)를 쓸 것.
 *   ⚠ ?provider=kakao 를 붙이면 다시 카카오로 판정되어 9999 가 난다.
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const url = require('url');
const os = require('os');
const zlib = require('zlib');

const PORT = 5500;
// 0.0.0.0 으로 열어야 같은 공유기의 다른 PC/모바일에서도 붙을 수 있다.
//   ⚠ 사내망/개인망 전용. 방화벽에서 5500 인바운드 허용이 필요할 수 있다.
const HOST = '0.0.0.0';
function lanIPs() {
    const out = [];
    const ifs = os.networkInterfaces();
    for (const k in ifs) for (const a of ifs[k] || []) {
        if (a.family === 'IPv4' && !a.internal) out.push(a.address);
    }
    return out;
}
const BUILD_ROOT = 'C:/Users/a/Desktop/Build';
const MAP_FILE = 'C:/Users/a/Documents/hi5-sdk/scripts/kakao-gamecodes.json';
const USE_HTTP = process.argv.includes('--http');
const BS = String.fromCharCode(92);   // 경로 표시용 역슬래시

// GameCode → 후보 이름들
let CODE2NAMES = {};
try {
    const m = JSON.parse(fs.readFileSync(MAP_FILE, 'utf8'));
    (m.games || []).forEach(g => { CODE2NAMES[g.gameCode] = g.names || []; });
} catch (e) { console.warn('매핑 파일 로드 실패:', e.message); }

// hi5-sdk 의 kakao-gamecodes.json 은 2026-06-01 확정 25종 기준이라 2차 10종이 빠져 있다.
// 그쪽은 여기서 보강한다(Projects.md 의 2차 타겟 표 기준).
const EXTRA = {
    bgrpeuds: ['Z-wuhuarou', '네오의밥도둑'],
    t4ovxhfb: ['116SpaceVaves', '아슬아슬비행기'],
    '1ayvw3jf': ['37AgeOf2048', '버니월드2048'],
    l7tiepxy: ['35ColorDot', '도트매니아'],
    '7cj3eg3x': ['105-cannon-pang', '캐논팡팡'],
    '2a92ziu0': ['108-three-mahjong_puzzle', '108-three-mahjong', '3매치사천성'],
    w5psctp1: ['Z-WaterCup', '해피워터컵'],
    fe242akk: ['07MergeDrop', '머지브레인롯'],
    '4b2us7wa': ['106-drop-the-ball', '드롭더볼'],
    '52c1wzya': ['20SortWool', '울소트퍼즐'],
    wxyqsakl: ['Z-PocketBall', '포켓볼'],
};
for (const k in EXTRA) { if (!CODE2NAMES[k]) CODE2NAMES[k] = EXTRA[k]; }

// 빌드 폴더 후보를 만들어 실제 index.html 이 있는 경로를 고른다.
//   폴더 구조가 제각각이라(평면 / web-mobile 2단계 / Egret bin-release) 전부 훑는다.
// 빌드 산출물의 디버그 지문을 읽는다.
//   CC3: settings.<hash>.json 의 engine.debug (없으면 debug)
//   CC2: src/settings.js 의 debug:true|false
//   판정 불가면 null 을 돌려주고 폴더명으로 2차 판정한다.
function buildFlag(dir) {
    // settings 는 엔진/버전마다 루트에도 src/ 에도, .json 으로도 .js 로도 나온다.
    //   CC2.4  → src/settings.<hash>.js  안의 debug:true|false
    //   CC3.8  → src/settings.<hash>.json 안의 engine.debug
    // 한쪽만 훑으면 대부분 판독 불가로 떨어져 폴더명에만 기대게 된다.
    const dirs = [dir, path.join(dir, 'src'), path.join(dir, 'assets', 'main')];
    for (const d of dirs) {
        let files = [];
        try { files = fs.readdirSync(d); } catch (e) { continue; }
        for (const f of files) {
            if (!/^settings.*\.(json|js)$/i.test(f)) continue;
            let raw = '';
            try { raw = fs.readFileSync(path.join(d, f), 'utf8'); } catch (e) { continue; }
            if (/\.json$/i.test(f)) {
                try {
                    const j = JSON.parse(raw);
                    const dbg = (j.engine && j.engine.debug !== undefined) ? j.engine.debug
                              : (j.debug !== undefined ? j.debug : undefined);
                    if (dbg !== undefined) return dbg ? 'debug' : 'release';
                } catch (e) {}
            }
            // .js 는 물론, JSON 파싱에 실패한 .json 도 텍스트로 한 번 더 본다.
            if (/["']?debug["']?\s*:\s*true/.test(raw)) return 'debug';
            if (/["']?debug["']?\s*:\s*false/.test(raw)) return 'release';
        }
    }
    // CC3 는 릴리즈에서만 번들에 md5 를 박는다. application.js 맨몸이면 디버그.
    try {
        const root = fs.readdirSync(dir);
        if (root.some(f => /^application\.[0-9a-f]{5,}\.js$/i.test(f))) return 'release';
        if (root.indexOf('application.js') >= 0) return 'debug';
    } catch (e) {}
    return null;
}

// 릴리즈 산출물인가. 지문이 우선, 없으면 경로에 debug 가 섞였는지로 본다.
//   ⚠ 116SpaceVaves 처럼 -debug 폴더에 릴리즈 산출물이 들어앉은 사례가 있어
//     폴더명만 믿으면 안 된다(그 반대도 마찬가지).
function isReleaseBuild(dir) {
    const f = buildFlag(dir);
    if (f) return f === 'release';
    return !/[-_]debug/i.test(dir.split(BS).join('/'));
}

// 빌드 폴더 후보를 만들어 실제 index.html 이 있는 **릴리즈** 경로를 고른다.
//   폴더 구조가 제각각이라(평면 / web-mobile 2단계 / Egret bin-release) 전부 훑는다.
//   ⚠ 로컬 뷰어는 릴리즈만 연다 — 디버그 산출물은 후보에서 통째로 뺀다.
function resolveBuild(code) {
    const names = CODE2NAMES[code] || [];
    const cands = [];
    for (const n of names) {
        // 릴리즈 계열 접미사만. -debug/-qa2/-fs/-ori/-restore 는 쳐다보지 않는다.
        for (const suffix of ['-release', '-live', '']) {
            cands.push(path.join(BUILD_ROOT, n + suffix));
            cands.push(path.join(BUILD_ROOT, n + suffix, 'web-mobile'));
        }
        // Egret 계열은 프로젝트 폴더 안에 있다(bin-release 가 곧 릴리즈)
        cands.push(path.join('C:/Users/a/Documents/Projects', n, 'egret/bin-release/web/kakao'));
        cands.push(path.join('C:/Users/a/Documents/Projects', n, 'build/web-mobile'));
    }
    for (const c of cands) {
        try {
            if (!fs.existsSync(path.join(c, 'index.html'))) continue;
            if (!isReleaseBuild(c)) continue;
            return c;
        } catch (e) {}
    }
    return null;
}

// ── hi5 호스트 흉내내기 ────────────────────────────────────────────────────
//   일부 게임(예: Z-JumpUpGirl)은 비카카오에서 Hi5.Init_SDK 로 부모 iframe 에
//   INIT_SDK 를 보낸 뒤 GAME_DATA 응답을 기다린다. 로컬 뷰어는 iframe 없이 단독으로 열어
//   그 응답이 영영 오지 않아 Loading 씬에서 멈춘다(리소스는 정상 로드된다).
//   → 게임이 보내는 postMessage 를 받아 GAME_DATA 를 자기 자신에게 돌려준다.
//   shape 은 hi5-sdk 의 _synthInitArgs() 와 동일하게 맞춘다.
const HI5_HOST_SHIM = [
'<script>(function(){',
'  if (window.__hi5HostShim) return; window.__hi5HostShim = 1;',
'  /* 기본 언어를 한국어로. Hi5Helper 계열은 localStorage._hi5_lang 을 최우선으로 읽고,',
'     없으면 navigator.language 를 따른다 — 브라우저가 영어면 영문으로 떠서 확인이 불편하다.',
'     이미 값이 있으면(게임 안에서 바꾼 경우) 존중해 덮어쓰지 않는다. */',
'  try { if (!localStorage.getItem("_hi5_lang")) localStorage.setItem("_hi5_lang", "ko"); } catch (e) {}',
'  function payload(){',
'    return { fromhi5action: "GAME_DATA", data: {',
'      game_data: { high_score: 0, score: 0 },',
'      user_data: {},',
'      platform_data: { platform: "local", os: "", vibration: 0, SafeArea: { top: 0, bottom: 0 }, ads: {}, products: {} },',
'      current_time: Date.now()',
'    } };',
'  }',
'  function reply(){ try { window.postMessage(payload(), "*"); } catch (e) {} }',
'  /* 게임이 INIT_SDK 를 보내면 즉시 응답한다(iframe 이 없으면 parent===self 라 여기로 온다). */',
'  window.addEventListener("message", function(ev){',
'    var d = ev && ev.data; if (!d || !d.fromhi5action) return;',
'    if (d.fromhi5action === "INIT_SDK") reply();',
'  });',
'  /* ⚠ 한 번만 쏘면 안 된다 — 느린 환경(터널/모바일)에서는 게임이 아직 message 리스너를',
'     등록하기 전이라 그 한 발을 놓치고 Loading 에서 영영 멈춘다(실제로 겪음).',
'     게임 쪽에 _inited 중복 가드가 있어 여러 번 받아도 안전하므로 주기적으로 재발송한다. */',
'  var n = 0;',
'  var t = setInterval(function(){ reply(); if (++n >= 40) clearInterval(t); }, 300);',
'  window.addEventListener("load", reply);',
'})();</script>'
].join(String.fromCharCode(10));

const MIME = {
    '.html':'text/html; charset=utf-8', '.js':'application/javascript; charset=utf-8',
    '.mjs':'application/javascript; charset=utf-8', '.css':'text/css; charset=utf-8',
    '.json':'application/json; charset=utf-8', '.png':'image/png', '.jpg':'image/jpeg',
    '.jpeg':'image/jpeg', '.gif':'image/gif', '.svg':'image/svg+xml', '.ico':'image/x-icon',
    '.webp':'image/webp', '.ttf':'font/ttf', '.otf':'font/otf', '.woff':'font/woff',
    '.woff2':'font/woff2', '.mp3':'audio/mpeg', '.ogg':'audio/ogg', '.wav':'audio/wav',
    '.m4a':'audio/mp4', '.mp4':'video/mp4', '.wasm':'application/wasm',
    '.atlas':'text/plain; charset=utf-8', '.plist':'text/xml; charset=utf-8',
    '.fnt':'text/plain; charset=utf-8', '.txt':'text/plain; charset=utf-8',
};

// 터널(Cloudflare) 경유는 파일마다 왕복 지연이 붙어 Cocos 의 수백 개 에셋 로드가 느리다.
//   텍스트 계열만 gzip 하면 전송량이 크게 준다. 이미 압축된 이미지/오디오는 건드리지 않는다.
const GZIP_EXT = ['.html', '.js', '.mjs', '.css', '.json', '.txt', '.atlas', '.fnt', '.plist'];
function pickEncoding(req, ext) {
    if (GZIP_EXT.indexOf(ext) === -1) return null;
    const ae = String(req.headers['accept-encoding'] || '');
    if (ae.indexOf('gzip') === -1) return null;
    return 'gzip';
}

function indexPage() {
    const rows = Object.keys(CODE2NAMES).map(code => {
        const dir = resolveBuild(code);
        const name = (CODE2NAMES[code][CODE2NAMES[code].length - 1]) || code;
        return { code, name, dir };
    });
    const ok = rows.filter(r => r.dir), no = rows.filter(r => !r.dir);
    const li = r => `<li><a href="/${r.code}/">${r.name}</a> <code>${r.code}</code>` +
        `<span class="p">${r.dir ? r.dir.split(BS).join('/') : ''}</span></li>`;
    return `<!doctype html><meta charset="utf-8"><title>카카오 H5 로컬 뷰어</title>
<style>body{font:14px/1.6 system-ui,sans-serif;max-width:900px;margin:24px auto;padding:0 16px;color:#222}
h1{font-size:18px} h2{font-size:14px;margin-top:24px;color:#666}
ul{list-style:none;padding:0} li{padding:6px 0;border-bottom:1px solid #eee}
a{font-weight:600;text-decoration:none;color:#0b62d0} code{background:#f2f2f2;padding:1px 5px;border-radius:3px;margin-left:6px;font-size:12px}
.p{display:block;color:#999;font-size:11px} .note{background:#fff8e1;border-left:3px solid #ffb300;padding:8px 12px;margin:16px 0}</style>
<h1>카카오 H5 로컬 뷰어</h1>
<div class="note">127.0.0.1 접속이라 <b>비카카오(standalone)</b> 로 실행됩니다 — 로그인 없이 열리고 9999 가 나지 않습니다.<br>
카카오 로그·랭킹·공유는 동작하지 않습니다. 그쪽은 런처의 <b>테스트 진입 링크</b>를 쓰세요.<br>
⚠️ <code>?provider=kakao</code> 를 붙이면 다시 9999 가 납니다.<br>📦 <b>릴리즈 빌드만</b> 서빙합니다 — 디버그 산출물은 후보에서 제외됩니다.</div>
<h2>빌드됨 (${ok.length})</h2><ul>${ok.map(li).join('')}</ul>
<h2>릴리즈 빌드 없음 (${no.length})</h2><ul>${no.map(li).join('')}</ul>`;
}

const handler = (req, res) => {
    // 접속 로그 — 다른 기기에서 정말 도달하는지 확인하는 용도.
    //   여기에 안 찍히면 네트워크(공유기 AP 격리/다른 망)에서 막힌 것이고,
    //   찍히는데 화면이 안 뜨면 주소/경로 문제다.
    try {
        const ip = (req.socket && req.socket.remoteAddress || '').replace('::ffff:', '');
        if (ip && ip !== '127.0.0.1' && ip !== '::1') {
            console.log('[접속] ' + ip + '  ' + req.method + ' ' + req.url);
        }
    } catch (e) {}
    const u = url.parse(req.url);
    let p = decodeURIComponent(u.pathname);
    if (p === '/' || p === '/index.html') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
        return res.end(indexPage());
    }
    // 런처 UI 도 서빙한다 — 모바일/다른 PC 는 file:// 로 런처를 열 수 없다.
    if (p === '/launcher' || p === '/launcher/') {
        return fs.readFile(path.join(__dirname, 'index.html'), (err, buf) => {
            if (err) { res.writeHead(404); return res.end('launcher not found'); }
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
            res.end(buf);
        });
    }
    const m = p.match(/^\/([A-Za-z0-9]+)(\/.*)?$/);
    if (!m) { res.writeHead(404); return res.end('not found'); }
    const code = m[1];
    const rest = m[2] && m[2] !== '/' ? m[2] : '/index.html';
    const base = resolveBuild(code);
    if (!base) { res.writeHead(404, {'Content-Type':'text/html; charset=utf-8'});
        return res.end('릴리즈 빌드를 찾지 못했습니다: ' + code + ' — 디버그 산출물은 로컬 뷰어에서 열지 않습니다. <a href="/">목록</a>'); }
    const file = path.join(base, rest);
    if (!file.startsWith(base)) { res.writeHead(403); return res.end('forbidden'); }
    fs.readFile(file, (err, buf) => {
        if (err) { res.writeHead(404); return res.end('not found: ' + rest); }
        const ext = path.extname(file).toLowerCase();
        // index.html 에만 shim 을 끼운다. </head> 앞에 넣어 게임 스크립트보다 먼저 돌게 한다.
        let out = buf;
        if (ext === '.html') {
            let html = buf.toString('utf8');
            if (html.indexOf('__hi5HostShim') === -1) {
                html = html.indexOf('</head>') >= 0
                    ? html.replace('</head>', HI5_HOST_SHIM + '</head>')
                    : HI5_HOST_SHIM + html;
            }
            out = Buffer.from(html, 'utf8');
        }
        // ⚠ writeHead 는 압축 여부가 정해진 뒤 **한 번만** 부른다.
        //   먼저 writeHead 해두고 나중에 setHeader 를 부르면 ERR_HTTP_HEADERS_SENT 로 죽는다(실제로 겪음).
        const headers = {
            'Content-Type': MIME[ext] || 'application/octet-stream',
            'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=86400',
        };
        if (pickEncoding(req, ext) === 'gzip') {
            return zlib.gzip(out, (gerr, gz) => {
                if (gerr) { res.writeHead(200, headers); return res.end(out); }
                headers['Content-Encoding'] = 'gzip';
                headers['Vary'] = 'Accept-Encoding';
                res.writeHead(200, headers);
                res.end(gz);
            });
        }
        res.writeHead(200, headers);
        res.end(out);
    });
};

let server, scheme;
if (USE_HTTP) { server = http.createServer(handler); scheme = 'http'; }
else {
    const cert = 'C:/Users/a/Documents/Projects/21MergeDefense/cert.pem';
    const key  = 'C:/Users/a/Documents/Projects/21MergeDefense/key.pem';
    if (!fs.existsSync(cert)) { console.error('인증서 없음 — --http 로 실행하세요'); process.exit(1); }
    server = https.createServer({ cert: fs.readFileSync(cert), key: fs.readFileSync(key) }, handler);
    scheme = 'https';
}
server.listen(PORT, HOST, () => {
    console.log('========================================================');
    console.log(' 카카오 H5 로컬 뷰어');
    console.log('  이 PC :  ' + scheme + '://127.0.0.1:' + PORT + '/');
    const ips = lanIPs();
    if (ips.length) {
        console.log('  같은 공유기의 다른 기기(모바일 등):');
        ips.forEach(function (ip) {
            console.log('    목록   ' + scheme + '://' + ip + ':' + PORT + '/');
            console.log('    런처   ' + scheme + '://' + ip + ':' + PORT + '/launcher');
        });
    } else {
        console.log('  (LAN IP 를 찾지 못했습니다 — 네트워크 연결 확인)');
    }
    console.log('  종료:  Ctrl+C');
    console.log('========================================================');
});
