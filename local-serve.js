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
};
for (const k in EXTRA) { if (!CODE2NAMES[k]) CODE2NAMES[k] = EXTRA[k]; }

// 빌드 폴더 후보를 만들어 실제 index.html 이 있는 경로를 고른다.
//   폴더 구조가 제각각이라(평면 / web-mobile 2단계 / Egret bin-release) 전부 훑는다.
function resolveBuild(code) {
    const names = CODE2NAMES[code] || [];
    const cands = [];
    for (const n of names) {
        for (const suffix of ['-debug', '-release', '']) {
            cands.push(path.join(BUILD_ROOT, n + suffix));
            cands.push(path.join(BUILD_ROOT, n + suffix, 'web-mobile'));
        }
        // Egret 계열은 프로젝트 폴더 안에 있다
        cands.push(path.join('C:/Users/a/Documents/Projects', n, 'egret/bin-release/web/kakao'));
        cands.push(path.join('C:/Users/a/Documents/Projects', n, 'build/web-mobile'));
    }
    for (const c of cands) {
        try { if (fs.existsSync(path.join(c, 'index.html'))) return c; } catch (e) {}
    }
    return null;
}

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
⚠️ <code>?provider=kakao</code> 를 붙이면 다시 9999 가 납니다.</div>
<h2>빌드됨 (${ok.length})</h2><ul>${ok.map(li).join('')}</ul>
<h2>빌드 없음 (${no.length})</h2><ul>${no.map(li).join('')}</ul>`;
}

const handler = (req, res) => {
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
        return res.end('빌드를 찾지 못했습니다: ' + code + ' — <a href="/">목록</a>'); }
    const file = path.join(base, rest);
    if (!file.startsWith(base)) { res.writeHead(403); return res.end('forbidden'); }
    fs.readFile(file, (err, buf) => {
        if (err) { res.writeHead(404); return res.end('not found: ' + rest); }
        const ext = path.extname(file).toLowerCase();
        res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream',
            'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=60' });
        res.end(buf);
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
