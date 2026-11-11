/**
 * SHOPLINE → BigQuery 每日自動同步
 *
 * 會同步：
 *   1. 會員資料（只抓有變動的）→ crm.members_*
 *   2. LINE 對照表 → crm.line_map_*
 *   3. 訂單與商品明細 → crm.orders_* / crm.order_items_*
 * 不會寫入：姓名、email、電話、地址、生日、收件資訊。
 *
 * 使用方式：
 *   1. 專案設定 → 指令碼屬性：SHOPLINE_TOKEN_BRAND_A（之後可加 SHOPLINE_TOKEN_BRAND_B）
 *   2. 執行一次 setupSync()   → 建立資料表與自動排程
 *   3. 之後全自動：每天凌晨 3 點同步；歷史訂單會每 5 分鐘接力抓，抓完自動停止
 *   4. 想看進度：執行 syncStatus()
 */

const SYNC = {
  PROJECT_ID: 'your-gcp-project',
  LOCATION: 'asia-east1',
  DATASET: 'crm',
  TIMEZONE: 'Asia/Taipei',
  API: 'https:' + '/' + '/open.shopline.io/v1/',
  MAX_RUN_MS: 4.5 * 60 * 1000,        // Apps Script 一次最多 6 分鐘，留緩衝
  FLUSH_ROWS: 3000,                    // 累積多少筆就寫進 BigQuery 一次
  SKIN_FIELD: '肌膚性質',
  STORES: {
    brand_a: {
      name: 'DEMO SKIN', tokenProp: 'SHOPLINE_TOKEN_BRAND_A',
      members: 'members_brand_a', lineMap: 'line_map_brand_a',
      orders: 'orders_brand_a', items: 'order_items_brand_a', promos: 'order_promos_brand_a',
      customersSince: '2026-01-01T00:00:00Z',   // 上傳的會員檔匯出時間，之後只抓這之後有變動的
    },
    brand_b: {
      name: 'DEMO HAIR', tokenProp: 'SHOPLINE_TOKEN_BRAND_B',
      members: 'members_brand_b', lineMap: 'line_map_brand_b',
      orders: 'orders_brand_b', items: 'order_items_brand_b', promos: 'order_promos_brand_b',
      customersSince: '2026-01-01T00:00:00Z',
    },
  },
};

/* ================================================================== */
/* 你會手動執行的三個函式                                                */
/* ================================================================== */

/** 第一次執行：建立資料表、加欄位、設定自動排程 */
function setupSync() {
  Object.keys(SYNC.STORES).forEach(function (key) {
    const s = SYNC.STORES[key];
    if (!token_(s)) { Logger.log('⚪ ' + s.name + '：還沒設定 ' + s.tokenProp + '，略過'); return; }
    query_(`CREATE TABLE IF NOT EXISTS ${t_(s.orders)} (${ORDER_FIELDS.map(ddl_).join(', ')})`);
    query_(`CREATE TABLE IF NOT EXISTS ${t_(s.items)} (${ITEM_FIELDS.map(ddl_).join(', ')})`);
    query_(`CREATE TABLE IF NOT EXISTS ${t_(s.promos)} (${PROMO_FIELDS.map(ddl_).join(', ')})`);
    query_(`CREATE TABLE IF NOT EXISTS ${t_(s.lineMap)} (customer_id STRING, line_uid STRING)`);
    try { query_(`ALTER TABLE ${t_(s.members)} ADD COLUMN IF NOT EXISTS skin_type STRING`); } catch (e) {
      Logger.log('⚠️ ' + s.name + '：找不到會員表 ' + s.members + '，請先上傳會員 CSV。' + e.message);
    }
    Logger.log('✅ ' + s.name + '：資料表準備完成');
  });

  // 重設排程
  ScriptApp.getProjectTriggers().forEach(function (tr) { ScriptApp.deleteTrigger(tr); });
  ScriptApp.newTrigger('dailySync').timeBased().atHour(3).everyDays(1).inTimezone(SYNC.TIMEZONE).create();
  ScriptApp.newTrigger('backfillOrders').timeBased().everyMinutes(5).create();
  Logger.log('✅ 已設定：每天凌晨 3 點同步；歷史訂單每 5 分鐘接力抓取（抓完自動停止）');
  Logger.log('👉 可以先手動執行一次 dailySync 測試');
}

/** 每日同步（凌晨 3 點自動執行，也可以手動執行） */
function dailySync() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) {
    // 歷史訂單回補正在跑，6 分鐘後再試，避免當天沒同步到
    clearContinuation_();
    scheduleContinuation_(6);
    return;
  }
  const t0 = Date.now();
  try {
    clearContinuation_();
    for (const key of Object.keys(SYNC.STORES)) {
      const s = SYNC.STORES[key];
      if (!token_(s)) continue;
      const st = state_(key);
      if (!syncCustomers_(key, s, st, t0)) return scheduleContinuation_();
      if (!syncOrdersIncremental_(key, s, st, t0)) return scheduleContinuation_();
      st.lastDailyOk = new Date().toISOString();
      saveState_(key, st);
    }
    Logger.log('✅ 每日同步完成，耗時 ' + Math.round((Date.now() - t0) / 1000) + ' 秒');
  } finally {
    lock.releaseLock();
  }
}

/** 查看同步進度與各資料表筆數 */
function syncStatus() {
  Object.keys(SYNC.STORES).forEach(function (key) {
    const s = SYNC.STORES[key];
    if (!token_(s)) { Logger.log('⚪ ' + s.name + '：未設定 token'); return; }
    const st = state_(key);
    Logger.log('===== ' + s.name + ' =====');
    Logger.log('會員最後同步到：' + (st.custCursor || '（尚未）') + (st.cust ? '（進行中，第 ' + st.cust.page + ' 頁）' : ''));
    Logger.log('訂單最後同步到：' + (st.ordCursor || '（尚未）'));
    Logger.log('歷史訂單回補：' + (st.backfillDone ? '✅ 完成' : '進行中，已抓 ' + (st.backfillCount || 0) + ' 筆'));
    Logger.log('上次每日同步成功：' + (st.lastDailyOk || '（尚未）'));
    [s.members, s.lineMap, s.orders, s.items, s.promos].forEach(function (tb) {
      try {
        const r = query_(`SELECT COUNT(*) AS n FROM ${t_(tb)}`);
        Logger.log('   ' + tb + '：' + r[0].n + ' 筆');
      } catch (e) { Logger.log('   ' + tb + '：（尚未建立）'); }
    });
  });
}

/**
 * 重新抓一次全部歷史訂單（例如新增欄位之後）。
 * 執行一次即可：會建立需要的資料表、重設回補進度，背景每 5 分鐘接力，抓完自動停止。
 */
function rebackfillOrders() {
  Object.keys(SYNC.STORES).forEach(function (key) {
    const s = SYNC.STORES[key];
    if (!token_(s)) return;
    query_(`CREATE TABLE IF NOT EXISTS ${t_(s.promos)} (${PROMO_FIELDS.map(ddl_).join(', ')})`);
    const st = state_(key);
    st.backfillDone = false; st.backfillPrevId = null; st.backfillCount = 0;
    saveState_(key, st);
  });
  ScriptApp.getProjectTriggers().forEach(function (tr) {
    if (tr.getHandlerFunction() === 'backfillOrders') ScriptApp.deleteTrigger(tr);
  });
  ScriptApp.newTrigger('backfillOrders').timeBased().everyMinutes(5).create();
  Logger.log('✅ 已重設，背景會每 5 分鐘接力重新抓取全部訂單（約 1 小時），可用 syncStatus 看進度');
}

/** 歷史訂單回補（每 5 分鐘自動執行，全部抓完會自己移除排程） */
function backfillOrders() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return;
  const t0 = Date.now();
  try {
    let allDone = true;
    for (const key of Object.keys(SYNC.STORES)) {
      const s = SYNC.STORES[key];
      if (!token_(s)) continue;
      const st = state_(key);
      if (st.backfillDone) continue;
      allDone = false;
      if (!st.ordCursor) { st.ordCursor = new Date().toISOString(); saveState_(key, st); }   // 之後的訂單交給每日同步

      let orders = [], items = [], promos = [], done = false;
      while (Date.now() - t0 < SYNC.MAX_RUN_MS - 60000) {
        const params = { per_page: 100, sort_by: 'asc' };
        if (st.backfillPrevId) params.previous_id = st.backfillPrevId;
        const j = api_(s, 'orders', params);
        const list = (j && j.items) || [];
        list.forEach(function (o) { const m = mapOrder_(o); orders.push(m.order); items = items.concat(m.items); promos = promos.concat(m.promos); });
        if (list.length) st.backfillPrevId = list[list.length - 1].id;
        st.backfillCount = (st.backfillCount || 0) + list.length;
        if (list.length < 100) { done = true; break; }
        if (orders.length >= SYNC.FLUSH_ROWS) { flushOrders_(s, orders, items, promos); orders = []; items = []; promos = []; saveState_(key, st); }
      }
      flushOrders_(s, orders, items, promos);
      if (done) { st.backfillDone = true; Logger.log('✅ ' + s.name + ' 歷史訂單回補完成，共 ' + st.backfillCount + ' 筆'); }
      else Logger.log('⏳ ' + s.name + ' 歷史訂單已抓 ' + st.backfillCount + ' 筆，下一輪繼續');
      saveState_(key, st);
      if (!done) break;   // 時間用完，下一輪再繼續
    }
    if (allDone) {
      ScriptApp.getProjectTriggers().forEach(function (tr) {
        if (tr.getHandlerFunction() === 'backfillOrders') ScriptApp.deleteTrigger(tr);
      });
      Logger.log('✅ 所有品牌歷史訂單都已完成，已移除回補排程');
    }
  } finally {
    lock.releaseLock();
  }
}

/* ================================================================== */
/* 會員                                                                */
/* ================================================================== */

const MEMBER_STAGE_FIELDS = [
  ['customer_id', 'STRING'], ['joined_at', 'STRING'], ['is_member', 'STRING'], ['registered_at', 'STRING'],
  ['last_login_at', 'STRING'], ['tier', 'STRING'], ['orders', 'INT64'], ['total_spent', 'INT64'],
  ['gender', 'STRING'], ['age_band', 'STRING'], ['tags', 'STRING'], ['line_registered', 'STRING'],
  ['accept_email_promo', 'STRING'], ['signup_utm_source', 'STRING'], ['signup_utm_medium', 'STRING'],
  ['signup_utm_campaign', 'STRING'], ['skin_type', 'STRING'], ['line_uid', 'STRING'],
];

/** @return true 表示完成；false 表示時間不夠，要接力 */
function syncCustomers_(key, s, st, t0) {
  if (!st.cust) st.cust = { since: st.custCursor || s.customersSince, until: new Date().toISOString(), page: 1 };
  let rows = [];
  while (true) {
    if (Date.now() - t0 > SYNC.MAX_RUN_MS) { flushMembers_(s, rows); saveState_(key, st); return false; }
    const j = api_(s, 'customers', { per_page: 100, page: st.cust.page, updated_after: st.cust.since, updated_before: st.cust.until });
    const list = (j && j.items) || [];
    list.forEach(function (c) { rows.push(mapCustomer_(c)); });
    const totalPages = j && j.pagination ? j.pagination.total_pages : 1;
    if (!list.length || st.cust.page >= totalPages) break;
    st.cust.page++;
    if (rows.length >= SYNC.FLUSH_ROWS) { flushMembers_(s, rows); rows = []; saveState_(key, st); }
  }
  flushMembers_(s, rows);
  Logger.log('✅ ' + s.name + ' 會員：' + st.cust.since + ' ~ ' + st.cust.until + ' 同步完成');
  st.custCursor = st.cust.until;
  delete st.cust;
  saveState_(key, st);
  return true;
}

function mapCustomer_(c) {
  const skinRaw = (c.custom_data || []).filter(function (d) {
    return d && d.name_translations && Object.keys(d.name_translations).some(function (k) { return d.name_translations[k] === SYNC.SKIN_FIELD; });
  }).map(function (d) { return String(d.value || ''); }).join(' ');
  const year = Number(c.birth_year);
  const age = year > 1900 ? (new Date().getFullYear() - year) : null;
  const utm = c.utm_data || {};
  const tierName = c.membership_tier ? (tr_(c.membership_tier.name_translations) || c.membership_tier.name || null) : (c.is_member ? '一般會員' : null);
  return {
    customer_id: c.id,
    joined_at: local_(c.created_at),
    is_member: c.is_member ? 'Y' : 'N',
    registered_at: local_(c.registered_at),
    last_login_at: local_(c.last_sign_in_at || c.current_sign_in_at),
    tier: tierName,
    orders: c.order_count || 0,
    total_spent: money_(c.orders_total_sum) || 0,
    gender: ({ female: '女', male: '男', other: '其他' })[c.gender] || (c.gender || null),
    age_band: ageBand_(age),
    tags: (c.tags || []).join(',') || null,
    line_registered: c.line_id ? 'Y' : 'N',
    accept_email_promo: c.is_subscribed_marketing_email ? 'Y' : 'N',
    signup_utm_source: utm.utm_source || null,
    signup_utm_medium: utm.utm_medium || null,
    signup_utm_campaign: utm.utm_campaign || null,
    skin_type: normalizeSkin_(skinRaw),
    line_uid: c.line_id || null,
  };
}

function flushMembers_(s, rows) {
  if (!rows.length) return;
  const stage = '_stg_members_' + s.members;
  load_(stage, MEMBER_STAGE_FIELDS, rows);

  // 依目標表實際的欄位型別轉換（上傳 CSV 時自動偵測的型別可能不同）
  const cols = query_(`SELECT column_name, data_type FROM \`${SYNC.PROJECT_ID}.${SYNC.DATASET}.INFORMATION_SCHEMA.COLUMNS\` WHERE table_name = '${s.members}'`);
  const type = {};
  cols.forEach(function (c) { type[c.column_name] = c.data_type; });
  const usable = MEMBER_STAGE_FIELDS.map(function (f) { return f[0]; })
    .filter(function (c) { return c !== 'customer_id' && c !== 'line_uid' && type[c]; });
  const val = function (c) { return `SAFE_CAST(S.${c} AS ${type[c]})`; };
  const sets = usable.map(function (c) {
    return c === 'skin_type' ? `skin_type = COALESCE(NULLIF(S.skin_type, ''), T.skin_type)` : `${c} = ${val(c)}`;
  });
  query_(`
    MERGE ${t_(s.members)} T
    USING (SELECT * FROM ${t_(stage)} WHERE customer_id IS NOT NULL QUALIFY ROW_NUMBER() OVER (PARTITION BY customer_id) = 1) S
    ON CAST(T.customer_id AS STRING) = S.customer_id
    WHEN MATCHED THEN UPDATE SET ${sets.join(', ')}
    WHEN NOT MATCHED THEN INSERT (customer_id, ${usable.join(', ')})
      VALUES (SAFE_CAST(S.customer_id AS ${type.customer_id || 'STRING'}), ${usable.map(val).join(', ')})`);
  query_(`
    MERGE ${t_(s.lineMap)} T
    USING (SELECT customer_id, ANY_VALUE(line_uid) AS line_uid FROM ${t_(stage)} WHERE line_uid IS NOT NULL GROUP BY customer_id) S
    ON CAST(T.customer_id AS STRING) = S.customer_id
    WHEN MATCHED THEN UPDATE SET line_uid = S.line_uid
    WHEN NOT MATCHED THEN INSERT (customer_id, line_uid) VALUES (S.customer_id, S.line_uid)`);
  Logger.log('   寫入會員 ' + rows.length + ' 筆');
}

/* ================================================================== */
/* 訂單                                                                */
/* ================================================================== */

const ORDER_FIELDS = [
  ['order_id', 'STRING'], ['order_number', 'STRING'], ['customer_id', 'STRING'], ['status', 'STRING'],
  ['created_at', 'TIMESTAMP'], ['updated_at', 'TIMESTAMP'], ['completed_at', 'TIMESTAMP'],
  ['subtotal', 'INT64'], ['total', 'INT64'], ['order_discount', 'INT64'], ['user_credit', 'INT64'], ['points_to_cash', 'INT64'],
  ['payment_method', 'STRING'], ['payment_status', 'STRING'], ['delivery_method', 'STRING'], ['delivery_status', 'STRING'],
  ['utm_source', 'STRING'], ['utm_medium', 'STRING'], ['utm_campaign', 'STRING'],
  ['coupon_codes', 'STRING'], ['promotions', 'STRING'], ['order_source', 'STRING'],
  ['is_guest', 'BOOL'], ['item_count', 'INT64'], ['synced_at', 'TIMESTAMP'],
];
const ITEM_FIELDS = [
  ['order_id', 'STRING'], ['order_created_at', 'TIMESTAMP'], ['customer_id', 'STRING'], ['line_no', 'INT64'],
  ['item_type', 'STRING'], ['product_id', 'STRING'], ['variation_id', 'STRING'], ['sku', 'STRING'], ['title', 'STRING'],
  ['quantity', 'INT64'], ['price', 'INT64'], ['total', 'INT64'],
];

// 每張訂單套用的每個優惠活動／折扣碼，各自折了多少
const PROMO_FIELDS = [
  ['order_id', 'STRING'], ['order_created_at', 'TIMESTAMP'], ['customer_id', 'STRING'], ['line_no', 'INT64'],
  ['promotion_id', 'STRING'], ['title', 'STRING'], ['coupon_code', 'STRING'], ['discounted_amount', 'INT64'],
];

function syncOrdersIncremental_(key, s, st, t0) {
  if (!st.ordCursor) { st.ordCursor = new Date().toISOString(); saveState_(key, st); return true; }  // 舊訂單交給回補
  if (!st.ord) st.ord = { since: st.ordCursor, until: new Date().toISOString(), prevId: null };
  let orders = [], items = [], promos = [];
  while (true) {
    if (Date.now() - t0 > SYNC.MAX_RUN_MS) { flushOrders_(s, orders, items, promos); saveState_(key, st); return false; }
    const params = { per_page: 100, sort_by: 'asc', updated_after: st.ord.since, updated_before: st.ord.until };
    if (st.ord.prevId) params.previous_id = st.ord.prevId;
    const j = api_(s, 'orders', params);
    const list = (j && j.items) || [];
    list.forEach(function (o) { const m = mapOrder_(o); orders.push(m.order); items = items.concat(m.items); promos = promos.concat(m.promos); });
    if (list.length) st.ord.prevId = list[list.length - 1].id;
    if (list.length < 100) break;
    if (orders.length >= SYNC.FLUSH_ROWS) { flushOrders_(s, orders, items, promos); orders = []; items = []; promos = []; saveState_(key, st); }
  }
  flushOrders_(s, orders, items, promos);
  Logger.log('✅ ' + s.name + ' 訂單：' + st.ord.since + ' ~ ' + st.ord.until + ' 同步完成');
  st.ordCursor = st.ord.until;
  delete st.ord;
  saveState_(key, st);
  return true;
}

function mapOrder_(o) {
  const items = (o.subtotal_items || []).map(function (it, i) {
    return {
      order_id: o.id, order_created_at: o.created_at, customer_id: o.customer_id || null, line_no: i + 1,
      item_type: it.item_type || null, product_id: it.item_id || null, variation_id: it.item_variation_id || null,
      sku: it.sku || null, title: tr_(it.title_translations), quantity: it.quantity || 0,
      price: money_(it.price), total: money_(it.total),
    };
  });
  const promos = o.promotion_items || [];
  const promoRows = promos.map(function (p, i) {
    return {
      order_id: o.id, order_created_at: o.created_at, customer_id: o.customer_id || null, line_no: i + 1,
      promotion_id: (p.promotion && p.promotion.id) || null,
      title: p.promotion ? tr_(p.promotion.title_translations) : null,
      coupon_code: typeof p.coupon_code === 'string' && p.coupon_code ? p.coupon_code : null,
      discounted_amount: money_(p.discounted_amount) || 0,
    };
  });
  const uniq = function (a) { return a.filter(function (x, i) { return x && a.indexOf(x) === i; }); };
  const utm = o.utm_data || {};
  return {
    order: {
      order_id: o.id, order_number: o.order_number || o.system_order_number || null, customer_id: o.customer_id || null,
      status: o.status || null, created_at: o.created_at || null, updated_at: o.updated_at || null, completed_at: o.completed_at || null,
      subtotal: money_(o.subtotal), total: money_(o.total), order_discount: money_(o.order_discount),
      user_credit: money_(o.user_credit), points_to_cash: money_(o.order_points_to_cash),
      payment_method: o.order_payment ? tr_(o.order_payment.name_translations) : null,
      payment_status: o.order_payment ? (o.order_payment.status || null) : null,
      delivery_method: o.order_delivery ? tr_(o.order_delivery.name_translations) : null,
      delivery_status: o.order_delivery ? (o.order_delivery.delivery_status || o.order_delivery.status || null) : null,
      utm_source: utm.utm_source || null, utm_medium: utm.utm_medium || null, utm_campaign: utm.utm_campaign || null,
      coupon_codes: uniq(promos.map(function (p) { return typeof p.coupon_code === 'string' ? p.coupon_code : null; })).join(',') || null,
      promotions: uniq(promos.map(function (p) { return p.promotion ? tr_(p.promotion.title_translations) : null; })).join('、') || null,
      order_source: o.order_source ? (o.order_source.type || null) : null,
      is_guest: !!o.is_guest_checkout,
      item_count: items.reduce(function (a, b) { return a + (b.quantity || 0); }, 0),
      synced_at: new Date().toISOString(),
    },
    items: items,
    promos: promoRows,
  };
}

function flushOrders_(s, orders, items, promos) {
  if (!orders.length) return;
  promos = promos || [];
  const so = '_stg_orders_' + s.orders, si = '_stg_items_' + s.items, sp = '_stg_promos_' + s.promos;
  load_(so, ORDER_FIELDS, orders);
  load_(si, ITEM_FIELDS, items);
  load_(sp, PROMO_FIELDS, promos);
  const cols = ORDER_FIELDS.map(function (f) { return f[0]; });
  query_(`
    MERGE ${t_(s.orders)} T
    USING (SELECT * FROM ${t_(so)} WHERE order_id IS NOT NULL QUALIFY ROW_NUMBER() OVER (PARTITION BY order_id ORDER BY updated_at DESC) = 1) S
    ON T.order_id = S.order_id
    WHEN MATCHED THEN UPDATE SET ${cols.filter(function (c) { return c !== 'order_id'; }).map(function (c) { return c + ' = S.' + c; }).join(', ')}
    WHEN NOT MATCHED THEN INSERT ROW`);
  query_(`DELETE FROM ${t_(s.items)} WHERE order_id IN (SELECT DISTINCT order_id FROM ${t_(so)})`);
  if (items.length) query_(`INSERT INTO ${t_(s.items)} SELECT * FROM ${t_(si)}`);
  query_(`DELETE FROM ${t_(s.promos)} WHERE order_id IN (SELECT DISTINCT order_id FROM ${t_(so)})`);
  if (promos.length) query_(`INSERT INTO ${t_(s.promos)} SELECT * FROM ${t_(sp)}`);
  Logger.log('   寫入訂單 ' + orders.length + ' 筆、商品明細 ' + items.length + ' 筆、優惠明細 ' + promos.length + ' 筆');
}

/* ================================================================== */
/* SHOPLINE API                                                        */
/* ================================================================== */

function token_(s) {
  const v = PropertiesService.getScriptProperties().getProperty(s.tokenProp);
  return v ? v.trim() : null;
}

function api_(s, path, params) {
  const qs = Object.keys(params || {}).filter(function (k) { return params[k] != null; })
    .map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]); }).join('&');
  const url = SYNC.API + path + (qs ? '?' + qs : '');
  for (let attempt = 1; attempt <= 5; attempt++) {
    const res = UrlFetchApp.fetch(url, {
      headers: { Authorization: 'Bearer ' + token_(s), 'Content-Type': 'application/json' },
      muteHttpExceptions: true,
    });
    const code = res.getResponseCode();
    if (code === 200) return JSON.parse(res.getContentText());
    if (code === 401 || code === 403) throw new Error(s.name + ' API 權限錯誤（HTTP ' + code + '），請檢查 token');
    Logger.log('   API ' + path + ' HTTP ' + code + '，第 ' + attempt + ' 次重試');
    Utilities.sleep(Math.min(30000, 2000 * attempt * attempt));
  }
  throw new Error(s.name + ' API 連續失敗：' + path);
}

/* ================================================================== */
/* BigQuery                                                            */
/* ================================================================== */

function t_(table) { return '`' + SYNC.PROJECT_ID + '.' + SYNC.DATASET + '.' + table + '`'; }
function ddl_(f) { return f[0] + ' ' + f[1]; }

function query_(sql) {
  let r = BigQuery.Jobs.query({ query: sql, useLegacySql: false, location: SYNC.LOCATION, timeoutMs: 60000 }, SYNC.PROJECT_ID);
  const jobId = r.jobReference.jobId;
  while (!r.jobComplete) {
    Utilities.sleep(1000);
    r = BigQuery.Jobs.getQueryResults(SYNC.PROJECT_ID, jobId, { location: SYNC.LOCATION, timeoutMs: 60000 });
  }
  if (!r.schema || !r.rows) return [];
  const f = r.schema.fields;
  return r.rows.map(function (row) { const o = {}; row.f.forEach(function (c, i) { o[f[i].name] = c.v; }); return o; });
}

/** 把資料寫進暫存表（每次覆寫） */
function load_(table, fields, rows) {
  if (!rows.length) return;
  const ndjson = rows.map(function (r) { return JSON.stringify(r); }).join('\n');
  const job = {
    jobReference: { projectId: SYNC.PROJECT_ID, location: SYNC.LOCATION },
    configuration: {
      load: {
        destinationTable: { projectId: SYNC.PROJECT_ID, datasetId: SYNC.DATASET, tableId: table },
        sourceFormat: 'NEWLINE_DELIMITED_JSON',
        writeDisposition: 'WRITE_TRUNCATE',
        createDisposition: 'CREATE_IF_NEEDED',
        schema: { fields: fields.map(function (f) { return { name: f[0], type: f[1] === 'INT64' ? 'INTEGER' : (f[1] === 'BOOL' ? 'BOOLEAN' : f[1]) }; }) },
      },
    },
  };
  let j = BigQuery.Jobs.insert(job, SYNC.PROJECT_ID, Utilities.newBlob(ndjson, 'application/octet-stream'));
  while (j.status.state !== 'DONE') {
    Utilities.sleep(1000);
    j = BigQuery.Jobs.get(SYNC.PROJECT_ID, j.jobReference.jobId, { location: SYNC.LOCATION });
  }
  if (j.status.errorResult) throw new Error('寫入 BigQuery 失敗：' + JSON.stringify(j.status.errors || j.status.errorResult).slice(0, 500));
}

/* ================================================================== */
/* 工具                                                                */
/* ================================================================== */

function state_(key) {
  const v = PropertiesService.getScriptProperties().getProperty('STATE_' + key);
  return v ? JSON.parse(v) : {};
}
function saveState_(key, st) {
  PropertiesService.getScriptProperties().setProperty('STATE_' + key, JSON.stringify(st));
}

function scheduleContinuation_(minutes) {
  minutes = minutes || 1;
  const tr = ScriptApp.newTrigger('dailySync').timeBased().after(minutes * 60 * 1000).create();
  PropertiesService.getScriptProperties().setProperty('CONTINUATION_ID', tr.getUniqueId());
  Logger.log('⏳ ' + minutes + ' 分鐘後自動接著跑');
}
function clearContinuation_() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty('CONTINUATION_ID');
  if (!id) return;
  ScriptApp.getProjectTriggers().forEach(function (tr) { if (tr.getUniqueId() === id) ScriptApp.deleteTrigger(tr); });
  props.deleteProperty('CONTINUATION_ID');
}

function money_(m) { return m && m.dollars != null ? Math.round(Number(m.dollars)) : null; }
function tr_(t) {
  if (!t) return null;
  if (typeof t === 'string') return t;
  return t['zh-hant'] || t['zh-tw'] || t.en || Object.keys(t).map(function (k) { return t[k]; })[0] || null;
}
function local_(iso) {
  return iso ? Utilities.formatDate(new Date(iso), SYNC.TIMEZONE, 'yyyy-MM-dd HH:mm:ss') : null;
}
function ageBand_(age) {
  if (age == null || age < 0 || age > 120) return null;
  if (age < 20) return '<20';
  if (age >= 60) return '60+';
  const lo = Math.floor(age / 5) * 5;
  return lo + '-' + (lo + 4);
}
/** 膚質整理：與上傳的 CSV 使用相同規則 */
function normalizeSkin_(s) {
  if (!s) return null;
  const rules = [['油性', '油'], ['乾性', '乾'], ['混合', '混'], ['敏感', '敏'], ['中性', '中'], ['痘痘', '痘'], ['泛紅', '紅'], ['毛孔', '毛孔']];
  const out = rules.filter(function (r) { return s.indexOf(r[1]) >= 0; }).map(function (r) { return r[0]; });
  return out.length ? out.join(',') : null;
}
