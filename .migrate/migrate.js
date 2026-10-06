/**
 * migrate.js —— 跑在 GitHub Actions 上：把腾讯云 COS 的视频搬进 GitHub Releases。
 * ------------------------------------------------------------------
 * 为什么不在本地跑：本机上行实测 0.02 MB/s，2.4GB 要 7–34 小时。
 * GitHub Actions 跑在 GitHub 自己的机器上，带宽是它的，几分钟就能搬完。
 *
 * 为什么**不需要任何凭证**：
 *   COS 桶是匿名可读的（站点本来就靠它给全世界出视频）。
 *   实测匿名 GET 返回 206，匿名 LIST 返回 403 —— 也就是说
 *   知道文件名就能取，不需要签名，也不需要那把根账号密钥。
 *   所以这里一个 secret 都不用设，直接把文件名写死在清单里。
 *   这比把全权限密钥交给 GitHub 安全得多。
 *
 * 幂等：同名资产在 Release 上已存在且大小一致就跳过。
 *       大小不一致就先删旧的再传，保证内容永远和 COS 一致。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const BUCKET = 'cheeselink-media-1500470066';
const REGION = 'ap-guangzhou';
const HOST = BUCKET + '.cos.' + REGION + '.myqcloud.com';

const GH_TOKEN = process.env.GH_TOKEN;
const GH_REPO = process.env.GH_REPO;
const GH_TAG = process.env.GH_TAG || 'media-v1';

const PREFIX = process.env.PREFIX || '';
const DRY = String(process.env.DRY_RUN || '').toLowerCase() === 'true';

const TMP = path.join(os.tmpdir(), 'cos-migrate');

/* 完整清单：直接取自 COS 的 list（用密钥列出来的权威大小）。
   大小用于判断「Release 上那份是不是同一个文件」，差一点点就重传。 */
const MANIFEST = [
  { key: 'coast-1080.mp4', size: 6230922 },
  { key: 'coast-4k.mp4', size: 33398127 },
  { key: 'cosmic-ocean-1080.mp4', size: 79268080 },
  { key: 'cosmic-ocean-4k.mp4', size: 1026828379 },
  { key: 'hero-1080.mp4', size: 26227222 },
  { key: 'hero-4k.mp4', size: 300052139 },
  { key: 'hero-full.mp4', size: 28562037 },
  { key: 'nte-1080.mp4', size: 40427818 },
  { key: 'nte-4k.mp4', size: 90345199 },
  { key: 'sea-1080.mp4', size: 9375390 },
  { key: 'sea-4k.mp4', size: 29895199 },
  { key: 'sea.mp4', size: 18025655 },
  { key: 'sintel-1080.mp4', size: 87452560 },
  { key: 'sintel-4k.mp4', size: 332576148 },
  { key: 'tos-1080.mp4', size: 89285919 },
  { key: 'tos-4k.mp4', size: 345288996 },
  { key: 'water-1080.mp4', size: 3286357 },
  { key: 'water-4k.mp4', size: 16795727 }
];

async function cosDownload(key, dest) {
  const url = 'https://' + HOST + '/' + key;
  const r = await fetch(url);
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const buf = Buffer.from(await r.arrayBuffer());
  fs.writeFileSync(dest, buf);
  return buf.length;
}

/* ── GitHub ── */
const GH = {
  Authorization: 'Bearer ' + GH_TOKEN,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'cheeselink-migrate'
};

async function ghJson(url, opts) {
  const r = await fetch(url, Object.assign({ headers: GH }, opts || {}));
  const t = await r.text();
  let j = null;
  try { j = JSON.parse(t); } catch (e) { j = { _raw: t.slice(0, 300) }; }
  return { status: r.status, ok: r.ok, j };
}

async function ensureRelease() {
  const base = 'https://api.github.com/repos/' + GH_REPO;
  let r = await ghJson(base + '/releases/tags/' + GH_TAG);
  if (r.ok) return r.j;

  console.log('Release ' + GH_TAG + ' 不存在，创建…');
  r = await ghJson(base + '/releases', {
    method: 'POST',
    headers: Object.assign({}, GH, { 'content-type': 'application/json' }),
    body: JSON.stringify({
      tag_name: GH_TAG,
      name: '芝士链 · 媒体文件',
      body: '站点大文件（视频）。由 Actions 从腾讯云 COS 迁入，用于替代产生外网流量费的旧源。'
    })
  });
  if (!r.ok) throw new Error('create release HTTP ' + r.status + ' ' + JSON.stringify(r.j).slice(0, 200));
  return r.j;
}

async function ghAssets(rel) {
  const map = {};
  for (let page = 1; page <= 10; page++) {
    const r = await ghJson('https://api.github.com/repos/' + GH_REPO + '/releases/' + rel.id + '/assets?per_page=100&page=' + page);
    if (!r.ok || !r.j.length) break;
    for (const a of r.j) map[a.name] = a;
  }
  return map;
}

async function ghUpload(rel, file, name) {
  const size = fs.statSync(file).size;
  const url = 'https://uploads.github.com/repos/' + GH_REPO + '/releases/' + rel.id +
    '/assets?name=' + encodeURIComponent(name);
  const r = await fetch(url, {
    method: 'POST',
    headers: Object.assign({}, GH, { 'Content-Type': 'application/octet-stream', 'Content-Length': String(size) }),
    body: fs.readFileSync(file)
  });
  const t = await r.text();
  let j = null;
  try { j = JSON.parse(t); } catch (e) { j = { _raw: t.slice(0, 300) }; }
  if (!r.ok) throw new Error('upload HTTP ' + r.status + ' ' + JSON.stringify(j).slice(0, 200));
  return j;
}

(async () => {
  if (!GH_TOKEN || !GH_REPO) { console.error('缺少 GITHUB_TOKEN / GH_REPO'); process.exit(1); }
  fs.mkdirSync(TMP, { recursive: true });

  console.log('=== 腾讯云 COS → GitHub Releases（免凭证）===');
  console.log('源: https://' + HOST + '/  （匿名读）');
  console.log('仓库: ' + GH_REPO + '  tag: ' + GH_TAG);
  console.log('前缀过滤: ' + (PREFIX || '(无)'));
  console.log('dry-run: ' + DRY);
  console.log('');

  let jobs = MANIFEST.slice();
  if (PREFIX) jobs = jobs.filter(o => o.key.indexOf(PREFIX) === 0 || o.key.includes(PREFIX));
  console.log('待处理: ' + jobs.length + ' 个，合计 ' +
    (jobs.reduce((a, b) => a + b.size, 0) / 1048576).toFixed(1) + ' MB\n');

  if (DRY) {
    for (const o of jobs) console.log('  ' + o.key.padEnd(30) + (o.size / 1048576).toFixed(2).padStart(10) + ' MB');
    console.log('\n(dry-run，未上传)');
    return;
  }

  const rel = await ensureRelease();
  const assets = await ghAssets(rel);
  console.log('Release 上现有资产: ' + Object.keys(assets).length + ' 个\n');

  let moved = 0, skipped = 0, failed = 0, bytes = 0;
  const t0 = Date.now();

  for (const o of jobs) {
    const local = path.join(TMP, o.key.replace(/[\\/]/g, '_'));
    process.stdout.write('─── ' + o.key.padEnd(26) + (o.size / 1048576).toFixed(2).padStart(9) + ' MB  ');

    const ex = assets[o.key];
    if (ex && Math.abs(ex.size - o.size) < 1024) {
      console.log('已在 Releases，跳过');
      skipped++;
      continue;
    }

    try {
      const dt = Date.now();
      const got = await cosDownload(o.key, local);
      const dl = (Date.now() - dt) / 1000;
      process.stdout.write('下载 ' + (got / 1048576).toFixed(1) + 'MB/' + dl.toFixed(0) + 's  ');

      if (ex) await ghJson('https://api.github.com/repos/' + GH_REPO + '/releases/assets/' + ex.id, { method: 'DELETE' });

      const ut = Date.now();
      const a = await ghUpload(rel, local, o.key);
      console.log('上传 ' + ((Date.now() - ut) / 1000).toFixed(0) + 's  ✅ ' + (a.size / 1048576).toFixed(1) + ' MB');
      bytes += a.size || 0;
      moved++;
    } catch (e) {
      console.log('❌ ' + e.message);
      failed++;
    } finally {
      try { fs.unlinkSync(local); } catch (e) { /* 清临时文件 */ }
    }
  }

  console.log('\n=== 汇总 ===');
  console.log('已搬 ' + moved + '   跳过 ' + skipped + '   失败 ' + failed);
  console.log('传输 ' + (bytes / 1048576).toFixed(1) + ' MB   耗时 ' + ((Date.now() - t0) / 60000).toFixed(1) + ' 分钟');
  if (failed) process.exit(1);
})().catch(e => { console.error('FATAL: ' + e.message); process.exit(1); });
