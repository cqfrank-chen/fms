/**
 * 回归：高危项修复端到端验证（并发幂等 / 归属 / 金额 / 日期）
 * ------------------------------------------------------------------
 * 覆盖：并发报工（中间道/末道只成功一次、工序只推进一道、成品与入库草稿不双计）、
 *       并发入库确认（库存只 +1 次）、并发核销（已核销不双计）、超额 0.006 被拒、
 *       跨订单行出库被拒、并发出库冲销（库存净 0）、并发订单确认（一单/一应收）、
 *       交期日期口径（纯日期 + 旧 UTC 零点数据均不偏移）、应收金额精确到分。
 *
 * 用法：node repro-highfix-e2e.mjs [baseUrl]     # 默认 http://localhost:8080（建议跑隔离测试栈）
 * 前置：目标库为空或可写入；脚本自建客户/产品/订单，不依赖既有数据。
 * 隔离栈起法（不改动生产栈）：
 *   $env:HTTP_PORT='8080'
 *   docker compose -p fms-highfix -f docker-compose.yml -f .fms-highfix/docker-compose.override.yml up -d --build
 */
/**
 * 高危项修复 · 端到端验证（跑在隔离测试栈上，默认 http://localhost:8080）
 * 覆盖：并发报工幂等、并发入库确认、并发核销/超核销、出库行归属、并发出库冲销、日期口径、金额定点。
 * 用法：node e2e-highfix.mjs [baseUrl]
 */
const BASE = (process.argv[2] || 'http://localhost:8080') + '/api';
let pass = 0, fail = 0;
const lines = [];
const ok = (name, cond, extra = '') => { (cond ? pass++ : fail++); lines.push(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  | ' + extra : ''}`); };

async function api(path, opt = {}) {
  const res = await fetch(BASE + path, { headers: { 'Content-Type': 'application/json' }, ...opt });
  const text = await res.text();
  let body = null; try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: res.status, ok: res.ok, body };
}
const get = (p) => api(p);
const post = (p, b) => api(p, { method: 'POST', body: b === undefined ? undefined : JSON.stringify(b) });
const put = (p, b) => api(p, { method: 'PUT', body: JSON.stringify(b) });
const pad = (n) => String(n).padStart(2, '0');
const localDate = (off = 0) => { const d = new Date(); d.setDate(d.getDate() + off); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const arr = (b) => Array.isArray(b) ? b : (b?.items ?? []);
const msg = (r) => JSON.stringify(r.body?.message ?? r.body).slice(0, 140);

const ts = Date.now();
const main = async () => {
  const h = await get('/health');
  ok('健康检查', h.status === 200 && h.body?.status === 'ok', `${h.status} ${JSON.stringify(h.body)}`);

  // ---------- 主数据 ----------
  const cust = await post('/customers', { name: `高修客户${ts}`, settlement: 'monthly_30', creditDays: 30 });
  const customerId = cust.body?.id;
  ok('创建客户', !!customerId, msg(cust));
  const pR = await post('/products', { name: `高修-有路由${ts}`, type: 'uk_acetylene', safetyStock: 0 });
  const pD = await post('/products', { name: `高修-直报${ts}`, type: 'uk_propane', safetyStock: 0 });
  ok('创建产品', !!pR.body?.id && !!pD.body?.id, msg(pR) + ' ' + msg(pD));
  const procs = arr((await get('/products/processes')).body);
  const mk = await put(`/products/${pR.body.id}/process-routes`, { items: [{ processId: procs[0].id, unitSeconds: 60 }, { processId: procs[1].id, unitSeconds: 60 }] });
  ok('配置两步工序路线', mk.status < 300, `${procs[0]?.name}→${procs[1]?.name} ${mk.status}`);

  // ---------- 订单 ----------
  const mkOrder = (pid, qty, price, due) => post('/orders', { customerId, dueDate: due, lines: [{ productId: pid, quantity: qty, unitPrice: price }] });
  const oA = await mkOrder(pR.body.id, 10, 1.23, localDate(1));
  const oB = await mkOrder(pR.body.id, 5, 2.0, localDate(1));
  const oC = await mkOrder(pD.body.id, 3, 0.1, localDate(1));
  const oD = await mkOrder(pR.body.id, 4, 1.0, '2026-10-05');
  const oD2 = await mkOrder(pR.body.id, 1, 1.0, '2026-10-04T16:00:00.000Z'); // 旧前端（东八区本地零点 UTC 化）
  ok('创建订单', [oA, oB, oC, oD, oD2].every((o) => o.status < 300), [oA, oB, oC, oD, oD2].map((o) => o.status).join(','));

  const cA = await post(`/orders/${oA.body.id}/confirm`);
  const cB = await post(`/orders/${oB.body.id}/confirm`);
  const cC = await post(`/orders/${oC.body.id}/confirm`);
  const cD = await post(`/orders/${oD.body.id}/confirm`);
  const cD2 = await post(`/orders/${oD2.body.id}/confirm`);
  ok('确认订单生成计划单', [cA, cB, cC, cD, cD2].every((x) => x.status < 300), [cA, cB, cC, cD, cD2].map((x) => x.status).join(','));

  // ---------- 日期口径（含旧格式兼容） ----------
  await post(`/plan-sheets/${cD.body.id}/audit`);
  await post(`/plan-sheets/${cD2.body.id}/audit`);
  const tasks = arr((await get('/scheduling/tasks')).body);
  const tD = tasks.find((t) => t.orderId === oD.body.id);
  const tD2 = tasks.find((t) => t.orderId === oD2.body.id);
  ok('交期日期（纯日期入参）不偏移', tD?.dueDate === '2026-10-05', `got=${tD?.dueDate}`);
  ok('交期日期（旧 UTC 零点数据）不偏移', tD2?.dueDate === '2026-10-05', `got=${tD2?.dueDate}`);

  // ---------- 金额定点 ----------
  const recs0 = arr((await get('/receivables')).body);
  const rC = recs0.find((r) => r.sourceId === oC.body.id && r.sourceType === 'order');
  ok('应收金额精确到分（3×0.10=0.30）', rC && Math.round(rC.amount * 100) === 30, `amount=${rC?.amount}`);

  // ---------- 出库行归属 ----------
  const lineA = oA.body.lines[0].id, lineB = oB.body.lines[0].id;
  const cross = await post('/outbounds', { orderId: oA.body.id, oqc: 'exempt', lines: [{ orderLineId: lineB, quantity: 1 }] });
  ok('跨订单行被拒绝', cross.status === 400, `status=${cross.status} ${msg(cross)}`);
  const good = await post('/outbounds', { orderId: oA.body.id, oqc: 'exempt', lines: [{ orderLineId: lineA, quantity: 5 }] });
  ok('合法出库单创建', good.status < 300, msg(good));

  // ---------- 并发报工（幂等） ----------
  await post(`/plan-sheets/${cA.body.id}/audit`);
  const pLine = cA.body.lines[0].id;
  const [m1, m2] = await Promise.all([
    post(`/plan-sheets/${cA.body.id}/report`, { lineId: pLine, doneQty: 10, routeSeq: 1, completedQuantity: 0 }),
    post(`/plan-sheets/${cA.body.id}/report`, { lineId: pLine, doneQty: 10, routeSeq: 1, completedQuantity: 0 }),
  ]);
  ok('并发中间道报工只成功一次', [m1, m2].filter((r) => r.status < 300).length === 1, `statuses=${m1.status},${m2.status} ${msg(m1)} ${msg(m2)}`);
  const afterM = (await get(`/plan-sheets/${cA.body.id}`)).body;
  ok('工序只推进一道', afterM.lines[0].routeSeq === 2, `routeSeq=${afterM.lines[0].routeSeq}`);

  const [f1, f2] = await Promise.all([
    post(`/plan-sheets/${cA.body.id}/report`, { lineId: pLine, doneQty: 10, routeSeq: 2, completedQuantity: 0 }),
    post(`/plan-sheets/${cA.body.id}/report`, { lineId: pLine, doneQty: 10, routeSeq: 2, completedQuantity: 0 }),
  ]);
  ok('并发末道报工只成功一次', [f1, f2].filter((r) => r.status < 300).length === 1, `statuses=${f1.status},${f2.status}`);
  const afterF = (await get(`/plan-sheets/${cA.body.id}`)).body;
  ok('成品数不被双计', afterF.lines[0].completedQuantity === 10, `completed=${afterF.lines[0].completedQuantity}`);
  ok('计划单完成', afterF.status === 'completed', `status=${afterF.status}`);
  const rc = arr((await get('/receipts')).body).find((x) => x.planSheetId === cA.body.id);
  const rcLine = rc?.lines?.find((l) => l.planSheetLineId === pLine);
  ok('入库草稿数量不被双计', rcLine?.quantity === 10, `qty=${rcLine?.quantity}`);

  // ---------- 并发入库确认 ----------
  const mr = await post('/receipts/manual', { productId: pD.body.id, quantity: 7 });
  const [q1, q2] = await Promise.all([post(`/receipts/${mr.body.id}/confirm`), post(`/receipts/${mr.body.id}/confirm`)]);
  ok('并发入库确认只成功一次', [q1, q2].filter((r) => r.status < 300).length === 1, `statuses=${q1.status},${q2.status}`);
  const invRows = arr((await get('/inventory')).body).filter((x) => x.productId === pD.body.id);
  const invSum = invRows.reduce((s, x) => s + x.quantity, 0);
  ok('库存只增加一次（7）', invSum === 7, `sum=${invSum}`);

  // ---------- 并发核销 / 超核销 ----------
  const recs = arr((await get('/receivables')).body);
  const rD = recs.find((r) => r.sourceId === oD.body.id && r.sourceType === 'order');
  const remD = rD.remain;
  const [s1, s2] = await Promise.all([
    post('/collection-slips', { partyId: customerId, mode: 'settle', amount: remD, lines: [{ id: rD.id, amount: remD }] }),
    post('/collection-slips', { partyId: customerId, mode: 'settle', amount: remD, lines: [{ id: rD.id, amount: remD }] }),
  ]);
  ok('并发核销只成功一次', [s1, s2].filter((r) => r.status < 300).length === 1, `statuses=${s1.status},${s2.status} ${msg(s1)} ${msg(s2)}`);
  const afterS = arr((await get('/receivables')).body).find((r) => r.id === rD.id);
  ok('已核销金额不被双计', Math.round(afterS.settledAmount * 100) === Math.round(rD.amount * 100), `settled=${afterS.settledAmount} amount=${rD.amount}`);

  const rB = arr((await get('/receivables')).body).find((r) => r.sourceId === oB.body.id && r.sourceType === 'order');
  const overAmt = Number((rB.remain + 0.006).toFixed(3));
  const over = await post('/collection-slips', { partyId: customerId, mode: 'settle', amount: overAmt, lines: [{ id: rB.id, amount: overAmt }] });
  ok('核销超额 0.006 被拒绝（旧容差 0.009 会放行）', over.status === 400, `status=${over.status} ${msg(over)}`);

  // ---------- 并发出库冲销 ----------
  await post(`/outbounds/${good.body.id}/submit`);
  const [v1, v2] = await Promise.all([post(`/outbounds/${good.body.id}/void`), post(`/outbounds/${good.body.id}/void`)]);
  ok('并发出库冲销只成功一次', [v1, v2].filter((r) => r.status < 300).length === 1, `statuses=${v1.status},${v2.status}`);
  const routedInv = arr((await get('/inventory')).body).filter((x) => x.productId === pR.body.id).reduce((s, x) => s + x.quantity, 0);
  ok('出库冲销库存回补一次（净 0）', routedInv === 0, `sum=${routedInv}`);

  // ---------- 并发订单确认 ----------
  const oE = await mkOrder(pD.body.id, 2, 1.0, localDate(2));
  const [e1, e2] = await Promise.all([post(`/orders/${oE.body.id}/confirm`), post(`/orders/${oE.body.id}/confirm`)]);
  ok('并发订单确认只成功一次', [e1, e2].filter((r) => r.status < 300).length === 1, `statuses=${e1.status},${e2.status}`);
  const plansE = arr((await get('/plan-sheets')).body).filter((p) => p.orderId === oE.body.id && p.status !== 'voided');
  ok('只生成一张计划单', plansE.length === 1, `count=${plansE.length}`);
  const recsE = arr((await get('/receivables')).body).filter((r) => r.sourceId === oE.body.id && r.sourceType === 'order' && r.status !== 'voided');
  ok('只开立一张应收', recsE.length === 1, `count=${recsE.length}`);

  console.log(lines.join('\n'));
  console.log(`\n=== 结果：PASS ${pass} / FAIL ${fail} ===`);
  process.exit(fail ? 1 : 0);
};
main().catch((e) => { console.log(lines.join('\n')); console.error('FATAL', e); process.exit(2); });