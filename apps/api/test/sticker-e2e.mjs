/**
 * 不干胶库存（I18）· 端到端自测脚本（真实 HTTP 接口 + 真实 PostgreSQL 断言 + 真实落盘校验）
 * ---------------------------------------------------------------------------
 * 覆盖：
 *   1) 鉴权：未登录 401（读/写都拦）；workshop 角色写操作 403（识图/建档/编辑/调量），
 *      但读操作（列表/详情/取图/流水）仍 200（与既有「读不限角色」约定一致）
 *   2) 上传识别：POST /stickers/recognize 上传**真实不干胶图片** → 返回建议字段 + rawText
 *      · `ok=true`   → 断言 品牌/样式/规格/数量/原文 与视觉通道返回一致，标题按规则组合
 *      · `ok=false`  → 断言 **HTTP 200 + 中文提示**（识图 Key 未配置/调用失败，绝不是 500），
 *                      且 imagePath 已落盘、可**手工填写后直接建档**（不编造任何字段）
 *   3) 建档：POST /stickers（用识别建议或手工字段）→ 断言 title/qty/unit/imagePath/rawText/备注缺项说明
 *   4) 查询：GET /stickers（关键词/品牌/客户筛选 + 分页）、GET /stickers/:id、GET /stickers/brands
 *   5) 取图：GET /stickers/:id/image → 200 + Content-Type: image/* + 字节数与磁盘文件一致；无图记录 404
 *   6) 数量维护：POST /stickers/:id/adjust 入库为正、领用为负、领超库存 400 中文、归零边界；
 *      流水 GET /stickers/:id/adjustments 留痕（变动前/变动量/变动后/操作人/备注）
 *   7) 编辑：PUT /stickers/:id（自动标题随字段重算；手工改过的标题不被覆盖）
 *   8) SQL 核对：stickers 行数、qty、image_path 落盘文件确实存在、sticker_adjustments 流水条数
 *
 * 前置：一个连到**空库**的 API 实例（会自动建表 + 种子 admin/Fms@2026），例如：
 *   DB_HOST=localhost DB_PORT=15432 DB_NAME=fms_e2e_sticker JWT_SECRET=e2e PORT=3200 \
 *   STICKER_UPLOAD_DIR=<绝对路径> node dist/main
 * 运行：node test/sticker-e2e.mjs
 * 环境变量：
 *   E2E_BASE         默认 http://127.0.0.1:3200/api
 *   E2E_PG_*         默认 localhost:15432 / fms / fms / fms_e2e_sticker
 *   E2E_STICKER_DIR  图片落盘根目录（默认 <api>/uploads/stickers，须与 API 的 STICKER_UPLOAD_DIR 一致）
 *   E2E_STICKER_SAMPLES 真实样本图片路径，多个用 ; 分隔（默认用内置 1×1 PNG，便于无样本环境跑通链路）
 *   E2E_MOCK_VISION  1 = 启动本地 OpenAI 兼容 mock 视觉服务（配 AI_VISION_BASE_URL 指向它即可跑通真实识图分支）
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import http from 'node:http';
import pg from 'pg';

const BASE = process.env.E2E_BASE ?? 'http://127.0.0.1:3200/api';
const PG_CONF = {
  host: process.env.E2E_PG_HOST ?? 'localhost',
  port: Number(process.env.E2E_PG_PORT ?? 15432),
  user: process.env.E2E_PG_USER ?? 'fms',
  password: process.env.E2E_PG_PASSWORD ?? 'fms',
  database: process.env.E2E_PG_DB ?? 'fms_e2e_sticker',
};
const STICKER_DIR = process.env.E2E_STICKER_DIR ?? join(process.cwd(), 'uploads', 'stickers');
const SAMPLES = (process.env.E2E_STICKER_SAMPLES ?? '').split(';').map((s) => s.trim()).filter(Boolean);

/** 无样本时的内置 1×1 PNG（保证脚本在任何环境都能跑通链路） */
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

/** mock 视觉通道返回的「识别结果」（用于验证真实视觉分支：品牌/样式/规格/数量/原文） */
const MOCK_VISION_JSON = {
  brand: 'GLOOR',
  style: '白盒贴',
  sizeSpec: '20×30mm',
  qty: '1000',
  unit: '张',
  customer: '',
  remark: '蓝色印刷，横版',
  rawText: 'GLOOR\n4734P\n20×30mm\nMADE IN CHINA',
};

let passCount = 0;
let failCount = 0;
const failures = [];

function ok(label, cond, detail) {
  if (cond) {
    passCount += 1;
    console.log('  ✅ ' + label + (detail === undefined ? '' : '  → ' + JSON.stringify(detail)));
  } else {
    failCount += 1;
    failures.push(label);
    console.log('  ❌ ' + label + '  实测：' + JSON.stringify(detail));
  }
}

function eq(label, actual, expected) {
  try {
    assert.deepEqual(actual, expected);
    ok(label, true, actual);
  } catch {
    ok(label, false, { actual, expected });
  }
}

async function req(method, path, body, token, extraHeaders = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
      ...extraHeaders,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const ct = res.headers.get('content-type') ?? '';
  if (!ct.includes('application/json')) {
    const buf = Buffer.from(await res.arrayBuffer());
    return { status: res.status, buf, contentType: ct, headers: res.headers };
  }
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : undefined; } catch { json = text; }
  return { status: res.status, body: json, contentType: ct, headers: res.headers };
}

const dataUrl = (buf, mime = 'image/jpeg') => 'data:' + mime + ';base64,' + buf.toString('base64');

/** 本地 OpenAI 兼容 mock 视觉服务：让「识图成功」分支可离线复现 */
function startMockVisionServer() {
  if (process.env.E2E_MOCK_VISION !== '1') return null;
  const port = Number(process.env.E2E_MOCK_VISION_PORT ?? 3299);
  const server = http.createServer((req2, res) => {
    let raw = '';
    req2.on('data', (c) => { raw += c; });
    req2.on('end', () => {
      const payload = {
        id: 'mock-1',
        object: 'chat.completion',
        model: 'mock-vl',
        choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(MOCK_VISION_JSON) }, finish_reason: 'stop' }],
      };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
    });
  });
  server.listen(port, '127.0.0.1');
  console.log('  · mock 视觉服务已启动 http://127.0.0.1:' + port + '/v1/chat/completions');
  return server;
}

async function main() {
  console.log('=== 不干胶库存 e2e（BASE=' + BASE + '，STICKER_DIR=' + STICKER_DIR + '）===');
  const mockServer = startMockVisionServer();
  const pool = new pg.Pool(PG_CONF);

  // 样本：优先用真实不干胶图片
  let sampleBuf;
  let sampleName;
  if (SAMPLES.length) {
    const p = SAMPLES[0];
    sampleBuf = readFileSync(p);
    sampleName = basename(p);
    console.log('  · 样本图片：' + p + '（' + sampleBuf.length + ' 字节）');
  } else {
    sampleBuf = TINY_PNG;
    sampleName = 'tiny.png';
    console.log('  · 未提供 E2E_STICKER_SAMPLES：使用内置 1×1 PNG');
  }

  try {
    // ================= 1. 鉴权：未登录 401 =================
    console.log('\n【1】鉴权：未登录一律 401');
    eq('未登录 GET /stickers → 401', (await req('GET', '/stickers')).status, 401);
    eq('未登录 GET /stickers/1 → 401', (await req('GET', '/stickers/1')).status, 401);
    eq('未登录 GET /stickers/1/image → 401', (await req('GET', '/stickers/1/image')).status, 401);
    eq('未登录 POST /stickers/recognize → 401', (await req('POST', '/stickers/recognize', { file: dataUrl(TINY_PNG, 'image/png') })).status, 401);
    eq('未登录 POST /stickers → 401', (await req('POST', '/stickers', { title: 'x' })).status, 401);
    eq('未登录 POST /stickers/1/adjust → 401', (await req('POST', '/stickers/1/adjust', { kind: 'in', qty: 1 })).status, 401);

    // ================= 2. 登录 + 造账号 =================
    console.log('\n【2】登录与账号准备');
    const login = await req('POST', '/auth/login', { username: 'admin', password: 'Fms@2026' });
    eq('admin 登录成功', login.status, 200);
    const token = login.body?.token;
    ok('拿到 admin token', !!token);

    await req('POST', '/users', { username: 'e2e_stk_wh', password: 'Wh@2026x', displayName: '不干胶仓管', role: 'warehouse' }, token);
    await req('POST', '/users', { username: 'e2e_stk_ws', password: 'Ws@2026x', displayName: '不干胶车间', role: 'workshop' }, token);
    const whLogin = await req('POST', '/auth/login', { username: 'e2e_stk_wh', password: 'Wh@2026x' });
    const wsLogin = await req('POST', '/auth/login', { username: 'e2e_stk_ws', password: 'Ws@2026x' });
    eq('warehouse 账号登录成功', whLogin.status, 200);
    eq('workshop 账号登录成功', wsLogin.status, 200);
    const whToken = whLogin.body?.token;
    const wsToken = wsLogin.body?.token;

    // ================= 3. 鉴权：workshop 写操作 403 =================
    console.log('\n【3】鉴权：workshop 角色写操作 403（读仍放行）');
    eq('workshop GET /stickers → 200（读不限角色）', (await req('GET', '/stickers', undefined, wsToken)).status, 200);
    eq('workshop POST /stickers/recognize → 403', (await req('POST', '/stickers/recognize', { file: dataUrl(sampleBuf, 'image/jpeg') }, wsToken)).status, 403);
    eq('workshop POST /stickers → 403', (await req('POST', '/stickers', { title: 'x' }, wsToken)).status, 403);
    eq('workshop PUT /stickers/1 → 403', (await req('PUT', '/stickers/1', { title: 'x' }, wsToken)).status, 403);
    eq('workshop POST /stickers/1/adjust → 403', (await req('POST', '/stickers/1/adjust', { kind: 'in', qty: 1 }, wsToken)).status, 403);

    // ================= 4. 上传识别（不写库） =================
    console.log('\n【4】上传识别 POST /stickers/recognize（真实样本图片）');
    const beforeCount = Number((await pool.query('select count(*)::int as n from stickers')).rows[0].n);
    const rec = await req('POST', '/stickers/recognize', { file: dataUrl(sampleBuf, 'image/jpeg'), fileName: sampleName }, whToken);
    eq('recognize 返回 200（只识别不写库；识图不可用时也是 200，不是 500）', rec.status, 200);
    const r = rec.body ?? {};
    ok('返回 imagePath（图片已落盘）', typeof r.imagePath === 'string' && r.imagePath.length > 0, r.imagePath);
    const absImg = r.imagePath ? join(STICKER_DIR, r.imagePath) : '';
    ok('imagePath 对应文件确实落盘', !!absImg && existsSync(absImg), absImg);
    ok('落盘字节数与上传一致', !!absImg && existsSync(absImg) && statSync(absImg).size === sampleBuf.length, existsSync(absImg) ? statSync(absImg).size : null);
    eq('recognize 不写库（stickers 行数不变）', Number((await pool.query('select count(*)::int as n from stickers')).rows[0].n), beforeCount);
    ok('返回 suggestion 结构完整', !!r.suggestion && typeof r.suggestion === 'object'
      && 'title' in r.suggestion && 'brand' in r.suggestion && 'style' in r.suggestion
      && 'sizeSpec' in r.suggestion && 'rawText' in r.suggestion && 'missing' in r.suggestion);

    let visionOk = false;
    if (r.ok === true) {
      visionOk = true;
      console.log('  · 识图成功分支：' + JSON.stringify({
        title: r.suggestion.title, brand: r.suggestion.brand, style: r.suggestion.style,
        sizeSpec: r.suggestion.sizeSpec, qty: r.suggestion.qty, rawText: r.suggestion.rawText,
      }));
      // 规则断言（对任何真实视觉模型都成立）：标题 = 品牌 + 样式/系列 + 规格，缺项省略
      const parts = [r.suggestion.brand, r.suggestion.style, r.suggestion.sizeSpec]
        .map((x) => String(x ?? '').trim()).filter(Boolean);
      eq('标题 = 品牌 + 样式/系列 + 规格（缺项省略，绝不臆造）',
        r.suggestion.title, parts.length ? parts.join(' ') : '未命名不干胶');
      ok('至少识别到一项有效字段或原文（不是空手而归）',
        !!(r.suggestion.brand || r.suggestion.style || r.suggestion.sizeSpec || r.suggestion.rawText),
        { brand: r.suggestion.brand, style: r.suggestion.style, sizeSpec: r.suggestion.sizeSpec });
      ok('缺项说明与 missing 自洽',
        (r.suggestion.missing.length === 0) === (parts.length === 3), r.suggestion.missing);
      ok('数量只认整数或留空（不猜数量）', r.suggestion.qty === null || Number.isInteger(r.suggestion.qty), r.suggestion.qty);
      if (process.env.E2E_MOCK_VISION === '1') {
        // 只有配了本地 mock 视觉通道时，才断言「识别值等于 mock 返回值」
        eq('品牌与 mock 视觉通道返回一致', r.suggestion.brand, MOCK_VISION_JSON.brand);
        eq('样式/系列与 mock 视觉通道返回一致', r.suggestion.style, MOCK_VISION_JSON.style);
        eq('规格与 mock 视觉通道返回一致', r.suggestion.sizeSpec, MOCK_VISION_JSON.sizeSpec);
        eq('数量解析为整数', r.suggestion.qty, 1000);
        eq('标题 = 品牌 + 样式/系列 + 规格', r.suggestion.title, 'GLOOR 白盒贴 20×30mm');
        ok('rawText 原样留痕', r.suggestion.rawText.includes('GLOOR') && r.suggestion.rawText.includes('MADE IN CHINA'), r.suggestion.rawText);
        eq('三项齐全 → 无缺项', r.suggestion.missing, []);
      }
    } else {
      console.log('  · 识图不可用分支（中文提示，手工建档）：' + JSON.stringify(r.message));
      ok('ok=false 时给出**中文**提示（不是 500/英文堆栈）', typeof r.message === 'string' && /[\u4e00-\u9fa5]/.test(r.message), r.message);
      ok('提示文案指向「识图 Key 未配置/识图调用失败」', /识图|Key|未配置|失败/.test(r.message ?? ''), r.message);
      eq('识图不可用时不编造字段（brand/style/sizeSpec 全空）',
        [r.suggestion.brand, r.suggestion.style, r.suggestion.sizeSpec], ['', '', '']);
      eq('识图不可用时不编造数量（qty 为 null）', r.suggestion.qty, null);
    }

    // ================= 5. 建档 =================
    console.log('\n【5】建档 POST /stickers');
    // 识图成功 → 用识别建议；识图不可用 → 手工填写（验证「手工建档路径」）
    const draft = visionOk
      ? {
          title: r.suggestion.title, brand: r.suggestion.brand, style: r.suggestion.style,
          sizeSpec: r.suggestion.sizeSpec, qty: r.suggestion.qty ?? 0, unit: r.suggestion.unit,
          remark: r.suggestion.remark, rawText: r.suggestion.rawText,
        }
      : {
          title: '', brand: 'GLOOR', style: '白盒贴', sizeSpec: '', qty: 100, unit: '张',
          remark: '手工填写（识图不可用）', rawText: undefined,
          aiNote: r.message,
        };
    const created = await req('POST', '/stickers', { ...draft, imagePath: r.imagePath }, whToken);
    ok('建档返回 201（新建资源）', created.status === 201, created.status);
    const s = created.body ?? {};
    ok('拿到记录 id', typeof s.id === 'number', s.id);
    const expectTitle = visionOk
      ? r.suggestion.title            // 识图成功 → 用识别建议标题
      : 'GLOOR 白盒贴';               // 手工填写缺规格 → 自动省略
    eq('标题按规则生成（缺项省略）', s.title, expectTitle);
    eq('数量入账', s.qty, visionOk ? (r.suggestion.qty ?? 0) : 100);
    eq('单位默认/识别值', s.unit, '张');
    eq('图片路径入库（相对路径，不是 base64）', s.imagePath, r.imagePath);
    ok('返回取图地址', s.imageUrl === '/api/stickers/' + s.id + '/image', s.imageUrl);
    if (!visionOk) {
      ok('缺项说明写进备注', typeof s.remark === 'string' && s.remark.includes('规格/尺寸'), s.remark);
      ok('识图不可用的中文提示留痕在备注', typeof s.remark === 'string' && /识图/.test(s.remark), s.remark);
    }

    // 无图手工建档（图片可选）
    const noImg = await req('POST', '/stickers', { title: '无图手工记录', brand: 'VICTOR', qty: 5, unit: '卷' }, whToken);
    ok('无图手工建档成功（图片可选）', noImg.status === 201, noImg.status);
    eq('无图记录 imagePath 为空', noImg.body?.imagePath ?? null, null);
    eq('无图记录取图 → 404', (await req('GET', '/stickers/' + noImg.body.id + '/image', undefined, token)).status, 404);

    // ================= 6. 查询 =================
    console.log('\n【6】查询 GET /stickers + 筛选 + 分页');
    const list = await req('GET', '/stickers?page=1&pageSize=10', undefined, token);
    eq('列表 200', list.status, 200);
    ok('列表含 total/page/pageSize/rows', ['total', 'page', 'pageSize', 'rows'].every((k) => k in (list.body ?? {})));
    ok('列表能查到刚建的记录', (list.body.rows ?? []).some((x) => x.id === s.id), (list.body.rows ?? []).map((x) => x.id));
    const kwList = await req('GET', '/stickers?kw=' + encodeURIComponent('GLOOR'), undefined, token);
    ok('关键词筛选命中', (kwList.body.rows ?? []).some((x) => x.id === s.id), kwList.body.total);
    const brandList = await req('GET', '/stickers?brand=' + encodeURIComponent('VICTOR'), undefined, token);
    ok('品牌筛选命中', (brandList.body.rows ?? []).every((x) => x.brand === 'VICTOR') && brandList.body.total >= 1, brandList.body.total);
    const cust = await req('POST', '/stickers', { title: '客户筛选样本', customer: '安宝公司', qty: 1 }, whToken);
    const custList = await req('GET', '/stickers?customer=' + encodeURIComponent('安宝'), undefined, token);
    ok('客户筛选命中', (custList.body.rows ?? []).some((x) => x.id === cust.body.id), custList.body.total);
    const one = await req('GET', '/stickers/' + s.id, undefined, token);
    ok('详情 200 且 id 一致', one.status === 200 && one.body?.id === s.id, { status: one.status, id: one.body?.id });
    const brands = await req('GET', '/stickers/brands', undefined, token);
    ok('品牌候选含 GLOOR/VICTOR', Array.isArray(brands.body) && brands.body.includes('GLOOR') && brands.body.includes('VICTOR'), brands.body?.slice(0, 8));
    eq('不存在的记录 → 404', (await req('GET', '/stickers/999999', undefined, token)).status, 404);

    // ================= 7. 取图 =================
    console.log('\n【7】取图 GET /stickers/:id/image');
    const img = await req('GET', '/stickers/' + s.id + '/image', undefined, token);
    eq('取图 200', img.status, 200);
    ok('Content-Type 是图片', String(img.contentType).startsWith('image/'), img.contentType);
    eq('取图字节数与磁盘文件一致', img.buf?.length, statSync(absImg).size);
    eq('未登录取图 401', (await req('GET', '/stickers/' + s.id + '/image')).status, 401);

    // ================= 8. 数量调整 =================
    console.log('\n【8】数量调整 POST /stickers/:id/adjust（入库/领用/边界）');
    const startQty = s.qty;
    const in1 = await req('POST', '/stickers/' + s.id + '/adjust', { kind: 'in', qty: 50, remark: '补货入库' }, whToken);
    eq('入库 200', in1.status, 200);
    eq('入库后数量 = 原数量 + 50', in1.body?.sticker?.qty, startQty + 50);
    eq('流水记录变动前/变动量/变动后', [in1.body.adjustment.qtyBefore, in1.body.adjustment.qtyDelta, in1.body.adjustment.qtyAfter], [startQty, 50, startQty + 50]);
    eq('流水方向为入库', in1.body.adjustment.kind, 'in');

    const out1 = await req('POST', '/stickers/' + s.id + '/adjust', { kind: 'out', qty: 30, remark: '车间领用' }, whToken);
    eq('领用 200', out1.status, 200);
    eq('领用后数量 = 原数量 + 50 - 30', out1.body?.sticker?.qty, startQty + 20);
    eq('领用流水增量为负', out1.body.adjustment.qtyDelta, -30);

    const over = await req('POST', '/stickers/' + s.id + '/adjust', { kind: 'out', qty: 999999 }, whToken);
    eq('领用超过库存 → 400', over.status, 400);
    ok('库存不足给中文提示', /库存不足/.test(JSON.stringify(over.body)), over.body?.message);

    const zero = await req('POST', '/stickers/' + s.id + '/adjust', { delta: -(startQty + 20) }, whToken);
    ok('带符号 delta 领用至 0 成功（边界归零）', zero.status === 200 && zero.body?.sticker?.qty === 0, { status: zero.status, qty: zero.body?.sticker?.qty });
    const oneMore = await req('POST', '/stickers/' + s.id + '/adjust', { kind: 'out', qty: 1 }, whToken);
    eq('0 库存再领用 1 → 400', oneMore.status, 400);
    eq('增量为 0 → 400', (await req('POST', '/stickers/' + s.id + '/adjust', { delta: 0 }, whToken)).status, 400);
    eq('数量为负 → 400', (await req('POST', '/stickers/' + s.id + '/adjust', { kind: 'in', qty: -5 }, whToken)).status, 400);
    eq('既不传 kind 也不传 delta → 400', (await req('POST', '/stickers/' + s.id + '/adjust', {}, whToken)).status, 400);
    eq('方向非法 → 400', (await req('POST', '/stickers/' + s.id + '/adjust', { kind: 'xx', qty: 1 }, whToken)).status, 400);

    const moves = await req('GET', '/stickers/' + s.id + '/adjustments', undefined, token);
    eq('流水接口 200', moves.status, 200);
    ok('流水含入库 + 领用记录（建档数量>0 时含初始数量）', moves.body.length >= (s.qty > 0 ? 3 : 2), moves.body.length);
    ok('流水带备注留痕', moves.body.some((m) => m.remark === '补货入库') && moves.body.some((m) => m.remark === '车间领用'));

    // ================= 9. 编辑 =================
    console.log('\n【9】编辑 PUT /stickers/:id');
    const up1 = await req('PUT', '/stickers/' + s.id, { sizeSpec: '30×40mm' }, whToken);
    eq('编辑 200', up1.status, 200);
    eq('自动标题随字段重算', up1.body.title, 'GLOOR 白盒贴 30×40mm');
    const up2 = await req('PUT', '/stickers/' + s.id, { title: '客户指定名称 ABC' }, whToken);
    eq('手工命名标题生效', up2.body.title, '客户指定名称 ABC');
    const up3 = await req('PUT', '/stickers/' + s.id, { style: '横版' }, whToken);
    eq('手工命名过的标题**不被字段覆盖**', up3.body.title, '客户指定名称 ABC');
    eq('字段本身已更新', up3.body.style, '横版');
    const upQty = await req('PUT', '/stickers/' + s.id, { qty: 77 }, whToken);
    eq('PUT 直接改数量生效', upQty.body.qty, 77);

    // ================= 10. SQL 核对 =================
    console.log('\n【10】SQL 核对（真实 PostgreSQL）');
    const row = (await pool.query('select * from stickers where id = $1', [s.id])).rows[0];
    ok('stickers 表存在该行', !!row, row ? row.id : null);
    eq('库中 qty 与接口一致', Number(row.qty), 77);
    eq('库中 image_path 是相对路径（非 base64）', row.image_path, r.imagePath);
    ok('库中 image_path 落盘文件存在', existsSync(join(STICKER_DIR, row.image_path)), join(STICKER_DIR, row.image_path));
    ok('库中 raw_text 与识别原文一致（手工建档时可为空）',
      visionOk ? row.raw_text === r.suggestion.rawText : true, row.raw_text);
    const cnt = await pool.query('select count(*)::int as n from stickers');
    const allIds = (await pool.query('select id from stickers')).rows.map((x) => x.id);
    ok('stickers 行数与接口 total 口径一致（>=3）', Number(cnt.rows[0].n) >= 3, { sql: Number(cnt.rows[0].n), ids: allIds });
    const flow = await pool.query('select count(*)::int as n from sticker_adjustments where sticker_id = $1', [s.id]);
    // 流水 = 建档初始数量(仅当建档数量>0) + 入库(1) + 领用(1) + 领用至 0(1) + PUT 修正数量(1)
    const expFlow = (s.qty > 0 ? 1 : 0) + 4;
    ok('流水条数 = 初始建档 + 入库 + 领用 + 归零 + PUT 修正 = ' + expFlow,
      Number(flow.rows[0].n) === expFlow, { sql: Number(flow.rows[0].n), expected: expFlow });
    ok('流水只增不改（qty_after 与 qty_before + qty_delta 自洽）',
      (await pool.query('select count(*)::int as n from sticker_adjustments where qty_after <> qty_before + qty_delta')).rows[0].n === 0);
    ok('PUT 改数量也留痕（编辑修正数量）',
      (await pool.query("select count(*)::int as n from sticker_adjustments where sticker_id = $1 and remark = '编辑修正数量'", [s.id])).rows[0].n === 1);
    ok('流水末条 qty_after = 库中数量', Number((await pool.query('select qty_after from sticker_adjustments where sticker_id = $1 order by id desc limit 1', [s.id])).rows[0].qty_after) === Number(row.qty), Number(row.qty));

    // ================= 11. 多张真实样本：识图通道逐张跑一遍 =================
    if (SAMPLES.length > 1) {
      console.log('\n【11】多张真实样本 · 逐张识别（' + SAMPLES.length + ' 张）');
      for (const p of SAMPLES) {
        const buf = readFileSync(p);
        const rr = await req('POST', '/stickers/recognize', { file: dataUrl(buf, 'image/jpeg'), fileName: basename(p) }, whToken);
        if (rr.status !== 200) { ok('样本识别 HTTP 200 ' + basename(p), false, rr.status); continue; }
        const sug = rr.body?.suggestion ?? {};
        ok('样本 ' + basename(p) + '：识别返回 ' + (rr.body.ok ? '成功' : '降级') + ' 建议标题=「' + (sug.title ?? '') + '」',
          rr.status === 200 && typeof sug.title === 'string', {
            ok: rr.body.ok, title: sug.title, brand: sug.brand, style: sug.style,
            sizeSpec: sug.sizeSpec, qty: sug.qty, rawText: (sug.rawText ?? '').slice(0, 80),
          });
        // 顺带建档，验证「真实样本 → 建档」全链路
        const c2 = await req('POST', '/stickers', { ...sug, imagePath: rr.body.imagePath, qty: sug.qty ?? 0 }, whToken);
        ok('样本建档 ' + basename(p), [200, 201].includes(c2.status) && typeof c2.body?.id === 'number', c2.body?.id);
      }
    }
  } finally {
    await pool.end().catch(() => {});
    mockServer?.close();
  }

  console.log('\n=== 结果：通过 ' + passCount + ' / 失败 ' + failCount + ' ===');
  if (failures.length) {
    console.log('失败项：\n - ' + failures.join('\n - '));
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('e2e 异常：', e);
  process.exit(1);
});
