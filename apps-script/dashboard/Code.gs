/**
 * 官網瀏覽數據儀表板 — 後端（Google Apps Script）
 * 資料來源：GA4 → BigQuery 每日匯出（events_YYYYMMDD）
 *
 * 部署前只需要修改下方 CONFIG。
 */
const CONFIG = {
  // Google Cloud 專案 ID（BigQuery 所在的專案）
  PROJECT_ID: 'your-gcp-project',

  // BigQuery 資料位置（連結 GA4 時選的位置）
  LOCATION: 'asia-east1',

  // 要追蹤的網站。dataset 名稱在 BigQuery 左側「探索工具」可以看到，格式為 analytics_數字
  // 第一個品牌就是網頁打開時的預設品牌
  SITES: [
    // members / lineMap：分眾名單用的會員資料表（放在 CRM_DATASET 裡），每個品牌各一份
    { key: 'brand_a', name: 'DEMO SKIN 保養', dataset: 'analytics_111111111', members: 'members_brand_a', lineMap: 'line_map_brand_a', hasSkin: true,
      orders: 'orders_brand_a', items: 'order_items_brand_a', promos: 'order_promos_brand_a' },
    { key: 'brand_b', name: 'DEMO HAIR 洗護', dataset: 'analytics_222222222', members: 'members_brand_b', lineMap: 'line_map_brand_b',
      orders: 'orders_brand_b', items: 'order_items_brand_b', promos: 'order_promos_brand_b' },
  ],

  // 單次查詢最多掃描的資料量（防止意外產生高額費用），預設 20 GB
  MAX_BYTES_BILLED: String(20 * 1024 * 1024 * 1024),

  // 彙總報表快取秒數（同一個人重複查同一區間時不會重新計費）
  CACHE_SECONDS: 3600,

  TIMEZONE: 'Asia/Taipei',
  MAX_RANGE_DAYS: 400,

  /* ---------- 分眾名單 ---------- */
  // 會員資料所在的 dataset（裡面放 members、line_map 兩張表）
  CRM_DATASET: 'crm',

  // LINE 推播連結裡帶會員 ID 的參數名稱，例如 ?mid=顧客ID（推播工具設定好之後就會自動生效）
  MEMBER_URL_PARAM: 'mid',

  // 「對優惠敏感」：瀏覽到標題或網址含這些字的頁面就算一次
  PROMO_KEYWORDS: ['優惠', '折扣', '特價', '限定', '限時', '活動', '促銷', '買一送一', '1+1', '滿額', '免運',
    '折價券', '折價', '加購', '贈品', '好禮', '雙11', '雙 11', 'promotion', 'sale', 'coupon', 'campaign'],

  // 「特定困擾」：選一個困擾，會用這些關鍵字比對商品名稱、頁面標題、網址和站內搜尋
  // 每個品牌各一組，請和行銷同事依照實際商品調整（關鍵字英文請用小寫）
  CONCERNS: {
    brand_b: {
      '頭皮出油': ['出油', '控油', '油性', '淨化', '清爽', '油頭'],
      '頭皮屑・頭皮癢': ['頭皮屑', '止癢', '頭癢', '癢', '舒緩'],
      '掉髮・髮量稀疏': ['掉髮', '落髮', '髮量', '豐盈', '強健', '養髮', '生髮'],
      '乾燥・缺水': ['乾燥', '保濕', '缺水', '滋潤', '水潤'],
      '毛躁・受損': ['毛躁', '受損', '修護', '髮膜', '柔順', '分岔'],
      '敏感': ['敏感', '溫和', '低敏', '無香'],
      '頭皮保養': ['頭皮', '頭皮精華', '頭皮淨化'],
    },
    brand_a: {
      '痘痘・粉刺': ['痘', '粉刺', '杏仁酸', '水楊酸', '淨痘', '抗痘'],
      '暗沉・斑點': ['亮白', '淨白', '美白', '透亮', '淡斑', '維他命c', '傳明酸'],
      '乾燥・缺水': ['保濕', '玻尿酸', '水光', '補水', '乾燥', '神經醯胺'],
      '敏感・泛紅': ['敏感', '舒緩', '舒敏', '積雪草', 'b5', '泛紅', '修護'],
      '抗老・細紋': ['抗老', 'a醇', '撫紋', '緊緻', '膠原', '胜肽', 'pdrn', '外泌體', '再生'],
      '毛孔・出油': ['毛孔', '控油', '出油', '收斂', '粉刺'],
      '防曬': ['防曬', 'spf', '抗陽'],
    },
  },
};

/* ------------------------------------------------------------------ */
/* 網頁入口                                                            */
/* ------------------------------------------------------------------ */

function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('官網瀏覽數據')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/* ------------------------------------------------------------------ */
/* 前端呼叫的 API（google.script.run）                                  */
/* ------------------------------------------------------------------ */

function getConfig() {
  return {
    sites: CONFIG.SITES.map(function (s) {
      return { key: s.key, name: s.name, ready: isDatasetReady_(s.dataset) };
    }),
    user: Session.getActiveUser().getEmail() || '',
  };
}

function getOverview(siteKey, start, end) {
  return cached_('ov', siteKey, start, end, function (t, p) {
    const sql = `
      WITH ${evCte_(t)},
      daily AS (
        SELECT
          event_date,
          COUNT(DISTINCT user_pseudo_id) AS users,
          COUNT(DISTINCT user_id) AS members,
          COUNT(DISTINCT IF(user_id IS NULL, NULL, user_pseudo_id)) AS member_devices,
          COUNT(DISTINCT sess) AS sessions,
          COUNTIF(event_name = 'page_view') AS pageviews
        FROM ev GROUP BY event_date
      )
      SELECT TO_JSON_STRING(STRUCT(
        (SELECT AS STRUCT
            COUNT(DISTINCT user_pseudo_id) AS users,
            COUNT(DISTINCT user_id) AS members,
            COUNT(DISTINCT IF(user_id IS NULL, NULL, user_pseudo_id)) AS member_devices,
            COUNT(DISTINCT sess) AS sessions,
            COUNTIF(event_name = 'page_view') AS pageviews,
            ROUND(IFNULL(SUM(eng_ms), 0) / 1000) AS eng_sec,
            COUNTIF(event_name = 'purchase') AS purchases,
            ROUND(IFNULL(SUM(IF(event_name = 'purchase', revenue, 0)), 0)) AS revenue
          FROM ev) AS totals,
        ARRAY(
          SELECT AS STRUCT
            FORMAT_DATE('%Y-%m-%d', PARSE_DATE('%Y%m%d', event_date)) AS date,
            users, members, member_devices, users - member_devices AS anon_devices,
            sessions, pageviews
          FROM daily ORDER BY date) AS daily,
        ARRAY(
          SELECT AS STRUCT IFNULL(device_cat, 'unknown') AS cat,
            COUNT(DISTINCT user_pseudo_id) AS users,
            COUNT(DISTINCT sess) AS sessions
          FROM ev GROUP BY cat ORDER BY users DESC) AS devices
      )) AS j`;
    return queryJson_(sql, p);
  });
}

function getContent(siteKey, start, end) {
  return cached_('ct2', siteKey, start, end, function (t, p) {
    // 售出數量與營收改用 SHOPLINE 訂單（以 SKU 對應 GA4 的 item_id），且只算到 GA4 已有資料的最後一天
    const tb = siteTables_(siteKey), crm = crmRef_();
    const hasOrders = !!(tb.orders && tb.items);
    const soCte = hasOrders ? `,
      so AS (
        SELECT UPPER(sku) AS sku, SUM(quantity) AS qty, ROUND(SUM(net)) AS rev
        FROM (
          SELECT i.sku, i.quantity, i.item_type,
            SAFE_DIVIDE(i.total * o.total, SUM(i.total) OVER (PARTITION BY i.order_id)) AS net
          FROM ${crm(tb.items)} i JOIN ${crm(tb.orders)} o USING (order_id)
          WHERE IFNULL(o.status, '') NOT IN ('cancelled', 'removed')
            AND FORMAT_DATE('%Y%m%d', DATE(o.created_at, '${CONFIG.TIMEZONE}'))
                BETWEEN @start AND LEAST(@end, (SELECT MAX(d) FROM it)))
        WHERE sku IS NOT NULL AND IFNULL(item_type, 'Product') != 'Gift'
        GROUP BY 1
      )` : '';
    const sql = `
      WITH ${evCte_(t)},
      pages AS (
        SELECT
          IFNULL(NULLIF(REGEXP_EXTRACT(page_location, r'^https?://[^/]+(/[^?#]*)'), ''), '/') AS path,
          MAX(IF(event_name = 'page_view', page_title, NULL)) AS title,
          COUNTIF(event_name = 'page_view') AS pageviews,
          COUNT(DISTINCT IF(event_name = 'page_view', user_pseudo_id, NULL)) AS users,
          IFNULL(SUM(eng_ms), 0) / 1000 AS eng_sec
        FROM ev
        WHERE page_location IS NOT NULL
        GROUP BY path
      ),
      it AS (
        SELECT e.event_name, e.user_pseudo_id, e.event_date AS d,
          IFNULL(i.item_id, i.item_name) AS k, i.item_id, i.item_name,
          IFNULL(i.quantity, 1) AS qty,
          IFNULL(i.item_revenue, IFNULL(i.price, 0) * IFNULL(i.quantity, 1)) AS rev
        FROM ${t} e, UNNEST(e.items) i
        WHERE _TABLE_SUFFIX BETWEEN @start AND @end
          AND e.event_name IN ('view_item', 'add_to_cart', 'begin_checkout', 'purchase')
          AND COALESCE(i.item_id, i.item_name) IS NOT NULL
      ),
      prod AS (
        SELECT
          ANY_VALUE(item_id) AS item_id,
          ANY_VALUE(item_name) AS name,
          COUNTIF(event_name = 'view_item') AS views,
          COUNT(DISTINCT IF(event_name = 'view_item', user_pseudo_id, NULL)) AS viewers,
          SUM(IF(event_name = 'add_to_cart', qty, 0)) AS add_to_cart,
          SUM(IF(event_name = 'purchase', qty, 0)) AS ga_purchased,
          ROUND(SUM(IF(event_name = 'purchase', rev, 0))) AS ga_revenue
        FROM it GROUP BY k
      )${soCte}
      SELECT TO_JSON_STRING(STRUCT(
        ${hasOrders ? "'shopline'" : "'ga4'"} AS sales_source,
        (SELECT MAX(d) FROM it) AS sales_through,
        ARRAY(
          SELECT AS STRUCT path, title, pageviews, users,
            ROUND(SAFE_DIVIDE(eng_sec, pageviews), 1) AS avg_sec
          FROM pages WHERE pageviews > 0
          ORDER BY pageviews DESC LIMIT 200) AS pages,
        ARRAY(
          SELECT AS STRUCT pr.item_id, pr.name, pr.views, pr.viewers, pr.add_to_cart,
            ${hasOrders ? 'IFNULL(so.qty, 0)' : 'pr.ga_purchased'} AS purchased,
            ${hasOrders ? 'IFNULL(so.rev, 0)' : 'pr.ga_revenue'} AS revenue
          FROM prod pr ${hasOrders ? 'LEFT JOIN so ON so.sku = UPPER(pr.item_id)' : ''}
          ORDER BY pr.views DESC, pr.add_to_cart DESC LIMIT 200) AS products
      )) AS j`;
    return queryJson_(sql, p);
  });
}

function getFunnel(siteKey, start, end) {
  return cached_('fn', siteKey, start, end, function (t, p) {
    const sql = `
      WITH ${evCte_(t)},
      s AS (
        SELECT sess,
          ANY_VALUE(device_cat) AS device_cat,
          LOGICAL_OR(user_id IS NOT NULL) AS is_member,
          LOGICAL_OR(event_name = 'view_item') AS v,
          LOGICAL_OR(event_name = 'add_to_cart') AS a,
          LOGICAL_OR(event_name = 'begin_checkout') AS c,
          LOGICAL_OR(event_name = 'purchase') AS p
        FROM ev WHERE sess IS NOT NULL GROUP BY sess
      )
      SELECT TO_JSON_STRING(ARRAY(
        SELECT AS STRUCT seg,
          COUNT(*) AS sessions,
          COUNTIF(v) AS view_item,
          COUNTIF(a) AS add_to_cart,
          COUNTIF(c) AS begin_checkout,
          COUNTIF(p) AS purchase
        FROM s, UNNEST([
          '全部',
          IF(is_member, '會員', '匿名'),
          CASE device_cat WHEN 'mobile' THEN '手機' WHEN 'desktop' THEN '電腦'
                          WHEN 'tablet' THEN '平板' ELSE '其他裝置' END
        ]) AS seg
        GROUP BY seg
      )) AS j`;
    return queryJson_(sql, p);
  });
}

function getSources(siteKey, start, end) {
  return cached_('sr2', siteKey, start, end, function (t, p) {
    const sql = `
      WITH ${evCte_(t)},
      s0 AS (
        SELECT sess,
          MIN(event_timestamp) AS t0,
          ANY_VALUE(user_pseudo_id) AS uid,
          LOGICAL_OR(user_id IS NOT NULL) AS is_member,
          LOWER(ARRAY_AGG(cts_source IGNORE NULLS ORDER BY event_timestamp LIMIT 1)[SAFE_OFFSET(0)]) AS src,
          LOWER(ARRAY_AGG(cts_medium IGNORE NULLS ORDER BY event_timestamp LIMIT 1)[SAFE_OFFSET(0)]) AS med,
          LOWER(ARRAY_AGG(IF(event_name = 'page_view', STRUCT(ref_host AS h), NULL) IGNORE NULLS
                          ORDER BY event_timestamp LIMIT 1)[SAFE_OFFSET(0)].h) AS ref,
          LOGICAL_OR(gclid IS NOT NULL) AS has_gclid,
          LOGICAL_OR(REGEXP_CONTAINS(IFNULL(page_location, ''), r'[?&]fbclid=')) AS has_fbclid,
          COUNTIF(event_name = 'page_view') AS pv,
          IFNULL(SUM(eng_ms), 0) / 1000 AS eng_sec,
          LOGICAL_OR(event_name = 'view_item') AS v,
          LOGICAL_OR(event_name = 'add_to_cart') AS a,
          LOGICAL_OR(event_name = 'purchase') AS p,
          IFNULL(SUM(IF(event_name = 'purchase', revenue, 0)), 0) AS rev
        FROM ev WHERE sess IS NOT NULL GROUP BY sess
      ),
      s AS (
        SELECT * EXCEPT (src, med, ref, has_gclid, has_fbclid, redir, prev),
          IF(redir, prev.src, src) AS src,
          IF(redir, prev.med, med) AS med,
          IF(redir, prev.ref, ref) AS ref,
          has_gclid OR (redir AND IFNULL(prev.has_gclid, FALSE)) AS has_gclid,
          has_fbclid OR (redir AND IFNULL(prev.has_fbclid, FALSE)) AS has_fbclid
        FROM (
          SELECT *,
            LAST_VALUE(IF(redir, NULL, STRUCT(src, med, ref, has_gclid, has_fbclid)) IGNORE NULLS)
              OVER (PARTITION BY uid ORDER BY t0 ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS prev
          FROM (
            SELECT *,
              REGEXP_CONTAINS(CONCAT(IFNULL(src, ''), ' ', IFNULL(ref, '')), ${checkoutRedirectRe_()}) AS redir
            FROM s0))
      ),
      c AS (
        SELECT *, ${channelCase_()} AS channel FROM s
      )
      SELECT TO_JSON_STRING(STRUCT(
        ARRAY(
          SELECT AS STRUCT channel,
            COUNT(*) AS sessions,
            COUNT(DISTINCT uid) AS users,
            ROUND(SAFE_DIVIDE(COUNTIF(is_member), COUNT(*)), 4) AS member_share,
            ROUND(AVG(pv), 2) AS pages_per_session,
            ROUND(AVG(eng_sec)) AS avg_eng_sec,
            ROUND(SAFE_DIVIDE(COUNTIF(v), COUNT(*)), 4) AS view_item_rate,
            ROUND(SAFE_DIVIDE(COUNTIF(a), COUNT(*)), 4) AS add_to_cart_rate,
            COUNTIF(p) AS purchases,
            ROUND(SAFE_DIVIDE(COUNTIF(p), COUNT(*)), 4) AS conversion_rate,
            ROUND(SUM(rev)) AS revenue
          FROM c GROUP BY channel ORDER BY sessions DESC) AS channels,
        ARRAY(
          SELECT AS STRUCT source, medium, channel, sessions, purchases
          FROM (
            SELECT
              IFNULL(src, IF(ref IS NULL, '(direct)', ref)) AS source,
              IFNULL(med, IF(ref IS NULL, '(none)', 'referral')) AS medium,
              channel,
              COUNT(*) AS sessions,
              COUNTIF(p) AS purchases,
              ROW_NUMBER() OVER (PARTITION BY channel ORDER BY COUNT(*) DESC) AS rn
            FROM c GROUP BY source, medium, channel)
          WHERE rn <= 30
          ORDER BY sessions DESC) AS detail
      )) AS j`;
    return queryJson_(sql, p);
  });
}

function getRecentMembers(siteKey, start, end) {
  return cached_('rm', siteKey, start, end, function (t, p) {
    const sql = `
      WITH ${evCte_(t)}
      SELECT TO_JSON_STRING(ARRAY(
        SELECT AS STRUCT user_id,
          FORMAT_DATETIME('%Y-%m-%d %H:%M',
            DATETIME(TIMESTAMP_MICROS(MAX(event_timestamp)), '${CONFIG.TIMEZONE}')) AS last_seen,
          COUNT(DISTINCT sess) AS sessions,
          COUNTIF(event_name = 'page_view') AS pageviews,
          COUNTIF(event_name = 'add_to_cart') AS add_to_cart,
          COUNTIF(event_name = 'purchase') AS purchases,
          COUNT(DISTINCT user_pseudo_id) AS devices
        FROM ev WHERE user_id IS NOT NULL
        GROUP BY user_id
        ORDER BY MAX(event_timestamp) DESC LIMIT 100
      )) AS j`;
    return queryJson_(sql, p);
  }, 600);
}

/**
 * 個別追蹤：輸入會員 ID（user_id）或裝置 ID（user_pseudo_id），
 * 回傳該會員所有登入過的裝置（含登入前的匿名行為）的事件時間軸。
 */
function getTimeline(siteKey, id, start, end) {
  id = String(id || '').trim();
  if (!/^[A-Za-z0-9._\-]{4,100}$/.test(id)) {
    throw new Error('ID 格式不正確：請輸入會員 ID 或裝置 ID（_ga 後面的數字）。');
  }
  // 使用者可能貼上整段 _ga cookie，例如 GA1.1.123456789.1793946570
  const m = id.match(/^GA\d\.\d\.(\d+\.\d+)$/);
  if (m) id = m[1];

  const t = tableRef_(siteKey);
  const p = rangeParams_(start, end);
  p.id = id;
  const sql = `
    WITH ids AS (
      SELECT DISTINCT user_pseudo_id FROM ${t}
      WHERE _TABLE_SUFFIX BETWEEN @start AND @end
        AND (user_id = @id OR user_pseudo_id = @id)
    )
    SELECT TO_JSON_STRING(ARRAY(
      SELECT AS STRUCT
        FORMAT_DATETIME('%Y-%m-%d %H:%M:%S',
          DATETIME(TIMESTAMP_MICROS(event_timestamp), '${CONFIG.TIMEZONE}')) AS t,
        event_name AS ev,
        user_pseudo_id AS pid,
        user_id AS uid,
        device.category AS dev,
        device.operating_system AS os,
        device.web_info.browser AS browser,
        geo.city AS city,
        (SELECT value.int_value FROM UNNEST(event_params) WHERE key = 'ga_session_id') AS sid,
        (SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'page_location') AS url,
        (SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'page_title') AS title,
        (SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'search_term') AS search,
        (SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'link_url') AS link,
        collected_traffic_source.manual_source AS src,
        collected_traffic_source.manual_medium AS med,
        ARRAY_TO_STRING(ARRAY(
          SELECT IFNULL(i.item_name, i.item_id) FROM UNNEST(items) i
          WHERE COALESCE(i.item_name, i.item_id) IS NOT NULL LIMIT 5), '、') AS items,
        ecommerce.purchase_revenue AS revenue
      FROM ${t}
      WHERE _TABLE_SUFFIX BETWEEN @start AND @end
        AND user_pseudo_id IN (SELECT user_pseudo_id FROM ids)
        AND event_name NOT IN ('user_engagement')
      ORDER BY event_timestamp
      LIMIT 3000
    )) AS j`;
  return { id: id, events: queryJson_(sql, p) || [] };
}

/* ------------------------------------------------------------------ */
/* 營收與回購（資料來源：SHOPLINE 同步的訂單）                           */
/* ------------------------------------------------------------------ */

/**
 * 共用：有效訂單（排除取消），並標記是否為「新客首購」。
 * 舊系統（SHOPLINE 之前）的訂單抓不到，所以用會員資料裡的「訂單數」比對：
 * 會員的訂單數 > SHOPLINE 裡的訂單數，代表他以前就買過，不算新客。
 */
function ordersCte_(siteKey) {
  const tb = siteTables_(siteKey);
  if (!tb.orders || !tb.items) throw new Error('這個品牌還沒有設定訂單資料表');
  const crm = crmRef_();
  return {
    tb: tb, crm: crm,
    sql: `
    allo AS (
      SELECT order_id, customer_id, status, total, subtotal, order_discount, created_at,
        DATE(created_at, '${CONFIG.TIMEZONE}') AS d, promotions, coupon_codes
      FROM ${crm(tb.orders)}
    ),
    o AS (SELECT * FROM allo WHERE IFNULL(status, '') NOT IN ('cancelled', 'removed')),
    cnt AS (SELECT customer_id, COUNT(*) AS n_all FROM allo WHERE customer_id IS NOT NULL GROUP BY customer_id),
    mem AS (
      SELECT CAST(customer_id AS STRING) AS customer_id, ANY_VALUE(IFNULL(SAFE_CAST(orders AS INT64), 0)) AS member_orders
      FROM ${crm(tb.members)} GROUP BY 1
    ),
    r AS (
      SELECT o.*,
        IF(o.customer_id IS NULL, NULL,
           ROW_NUMBER() OVER (PARTITION BY o.customer_id ORDER BY o.created_at)) AS seq,
        GREATEST(IFNULL(mem.member_orders, 0) - IFNULL(cnt.n_all, 0), 0) AS pre_orders
      FROM o
      LEFT JOIN cnt USING (customer_id)
      LEFT JOIN mem USING (customer_id)
    ),
    rr AS (
      SELECT *, (customer_id IS NULL OR (seq = 1 AND pre_orders = 0)) AS is_new FROM r
    )`,
  };
}

function getRevenue(siteKey, start, end) {
  return cached_('rev', siteKey, start, end, function (t, p) {
    const c = ordersCte_(siteKey);
    // 上一期：同樣長度、緊接在前
    const s0 = new Date(start + 'T00:00:00Z'), e0 = new Date(end + 'T00:00:00Z');
    const len = Math.round((e0 - s0) / 86400000) + 1;
    const ps = new Date(s0.getTime() - len * 86400000), pe = new Date(s0.getTime() - 86400000);
    const fmt = function (d) { return d.toISOString().slice(0, 10).replace(/-/g, ''); };
    p.pstart = fmt(ps); p.pend = fmt(pe);
    const kpi = function (from, to) {
      return `(SELECT AS STRUCT
          COUNT(*) AS orders,
          IFNULL(SUM(total), 0) AS revenue,
          COUNT(DISTINCT customer_id) AS buyers,
          COUNTIF(customer_id IS NULL) AS guest_orders,
          COUNTIF(is_new AND customer_id IS NOT NULL) AS new_customers,
          IFNULL(SUM(IF(is_new, total, 0)), 0) AS new_revenue,
          IFNULL(SUM(IF(NOT is_new, total, 0)), 0) AS returning_revenue,
          IFNULL(SUM(order_discount), 0) AS discount,
          IFNULL(SUM(subtotal), 0) AS subtotal
        FROM rr WHERE d BETWEEN PARSE_DATE('%Y%m%d', ${from}) AND PARSE_DATE('%Y%m%d', ${to}))`;
    };
    const sql = `
      WITH ${c.sql},
      inr AS (SELECT * FROM rr WHERE d BETWEEN PARSE_DATE('%Y%m%d', @start) AND PARSE_DATE('%Y%m%d', @end)),
      items AS (
        SELECT i.*, inr.is_new, inr.customer_id AS cid,
          -- 折扣後金額：把整張訂單的實付金額，依各品項原價小計的比例分攤
          SAFE_DIVIDE(i.total * inr.total, SUM(i.total) OVER (PARTITION BY i.order_id)) AS net
        FROM ${c.crm(c.tb.items)} i JOIN inr USING (order_id)
      ),
      months AS (
        SELECT FORMAT_DATE('%Y-%m', d) AS month,
          SUM(total) AS revenue, SUM(IF(is_new, total, 0)) AS new_revenue, SUM(IF(NOT is_new, total, 0)) AS returning_revenue,
          COUNT(*) AS orders, COUNT(DISTINCT customer_id) AS buyers, COUNTIF(is_new AND customer_id IS NOT NULL) AS new_customers
        FROM rr
        WHERE d >= DATE_SUB(DATE_TRUNC(PARSE_DATE('%Y%m%d', @end), MONTH), INTERVAL 12 MONTH)
          AND d <= PARSE_DATE('%Y%m%d', @end)
        GROUP BY month
      )
      SELECT TO_JSON_STRING(STRUCT(
        ${kpi('@start', '@end')} AS cur,
        ${kpi('@pstart', '@pend')} AS prev,
        ARRAY(SELECT AS STRUCT * FROM months ORDER BY month) AS monthly,
        ARRAY(
          SELECT AS STRUCT ANY_VALUE(title) AS title, ANY_VALUE(sku) AS sku,
            SUM(quantity) AS qty, ROUND(IFNULL(SUM(net), 0)) AS revenue, SUM(total) AS list_total, COUNT(DISTINCT cid) AS buyers,
            SAFE_DIVIDE(COUNT(DISTINCT IF(is_new, order_id, NULL)), COUNT(DISTINCT order_id)) AS new_share
          FROM items WHERE IFNULL(item_type, 'Product') != 'Gift'
          GROUP BY IFNULL(product_id, title) ORDER BY revenue DESC LIMIT 30) AS products
      )) AS j`;
    return queryJson_(sql, p);
  });
}

/**
 * 優惠活動與折扣碼成效：每個活動／折扣碼「各自」折了多少（來自訂單優惠明細）。
 * 一張訂單可能同時套用多個活動，所以各列的訂單與實付金額會重複計算。
 */
function getPromos(siteKey, start, end) {
  return cached_('promo', siteKey, start, end, function (t, p) {
    const c = ordersCte_(siteKey);
    if (!c.tb.promos) throw new Error('這個品牌還沒有設定優惠明細資料表');
    const sql = `
      WITH ${c.sql},
      inr AS (SELECT order_id, total, is_new FROM rr WHERE d BETWEEN PARSE_DATE('%Y%m%d', @start) AND PARSE_DATE('%Y%m%d', @end)),
      pr AS (
        SELECT x.order_id, x.title, x.coupon_code, IFNULL(x.discounted_amount, 0) AS disc, inr.total AS order_total, inr.is_new
        FROM ${c.crm(c.tb.promos)} x JOIN inr USING (order_id)
      ),
      byp AS (
        SELECT order_id, IFNULL(title, '(未命名活動)') AS name, ANY_VALUE(order_total) AS order_total,
          ANY_VALUE(is_new) AS is_new, SUM(disc) AS disc
        FROM pr GROUP BY order_id, name
      ),
      byc AS (
        SELECT order_id, coupon_code AS name, ANY_VALUE(order_total) AS order_total,
          ANY_VALUE(is_new) AS is_new, SUM(disc) AS disc
        FROM pr WHERE coupon_code IS NOT NULL GROUP BY order_id, name
      )
      SELECT TO_JSON_STRING(STRUCT(
        ARRAY(SELECT AS STRUCT name, COUNT(*) AS orders, SUM(order_total) AS revenue, SUM(disc) AS discount,
                SAFE_DIVIDE(COUNTIF(is_new), COUNT(*)) AS new_share
              FROM byp GROUP BY name ORDER BY orders DESC LIMIT 20) AS promotions,
        ARRAY(SELECT AS STRUCT name, COUNT(*) AS orders, SUM(order_total) AS revenue, SUM(disc) AS discount,
                SAFE_DIVIDE(COUNTIF(is_new), COUNT(*)) AS new_share
              FROM byc GROUP BY name ORDER BY orders DESC LIMIT 20) AS coupons
      )) AS j`;
    return queryJson_(sql, p);
  });
}

/** 回購分析：不受日期區間影響，看最近 13 個月的新客世代 */
function getRetention(siteKey) {
  const today = Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'yyyy-MM-dd');
  return cached_('ret', siteKey, today, today, function (t, p) {
    const c = ordersCte_(siteKey);
    const sql = `
      WITH ${c.sql},
      firsts AS (    -- 真正的新客：第一筆訂單、而且之前沒有舊系統訂單
        SELECT customer_id, d AS first_d, DATE_TRUNC(d, MONTH) AS cm, order_id AS first_order
        FROM rr WHERE customer_id IS NOT NULL AND seq = 1 AND pre_orders = 0
      ),
      act AS (SELECT DISTINCT customer_id, DATE_TRUNC(d, MONTH) AS am FROM o WHERE customer_id IS NOT NULL),
      second AS (SELECT customer_id, d AS second_d FROM rr WHERE seq = 2),
      f2 AS (
        SELECT f.*, s.second_d, DATE_DIFF(s.second_d, f.first_d, DAY) AS gap
        FROM firsts f LEFT JOIN second s USING (customer_id)
      ),
      recent AS (SELECT * FROM f2 WHERE cm >= DATE_SUB(DATE_TRUNC(CURRENT_DATE('${CONFIG.TIMEZONE}'), MONTH), INTERVAL 12 MONTH)),
      sizes AS (SELECT cm, COUNT(*) AS size FROM recent GROUP BY cm),
      cell AS (
        SELECT f.cm, DATE_DIFF(a.am, f.cm, MONTH) AS k, COUNT(DISTINCT f.customer_id) AS n
        FROM recent f JOIN act a USING (customer_id)
        WHERE a.am > f.cm
        GROUP BY f.cm, k
      ),
      cellarr AS (
        SELECT cm, ARRAY_AGG(STRUCT(k, n) ORDER BY k) AS ret
        FROM cell WHERE k <= 12 GROUP BY cm
      ),
      eligible90 AS (   -- 首購已滿 90 天的人，才能算 90 天回購率
        SELECT * FROM f2 WHERE first_d <= DATE_SUB(CURRENT_DATE('${CONFIG.TIMEZONE}'), INTERVAL 90 DAY)
          AND first_d >= DATE_SUB(CURRENT_DATE('${CONFIG.TIMEZONE}'), INTERVAL 455 DAY)
      ),
      firstitems AS (
        SELECT IFNULL(i.product_id, i.title) AS k, ANY_VALUE(i.title) AS title,
          COUNT(DISTINCT e.customer_id) AS new_customers,
          COUNT(DISTINCT IF(e.gap <= 90, e.customer_id, NULL)) AS repurchased_90
        FROM eligible90 e JOIN ${c.crm(c.tb.items)} i ON i.order_id = e.first_order
        WHERE IFNULL(i.item_type, 'Product') != 'Gift'
        GROUP BY k
      )
      SELECT TO_JSON_STRING(STRUCT(
        ARRAY(
          SELECT AS STRUCT FORMAT_DATE('%Y-%m', sz.cm) AS cohort, sz.size,
            IFNULL(ca.ret, ARRAY<STRUCT<k INT64, n INT64>>[]) AS ret
          FROM sizes sz LEFT JOIN cellarr ca USING (cm)
          ORDER BY sz.cm) AS cohorts,
        (SELECT AS STRUCT COUNT(*) AS customers,
            COUNTIF(gap <= 90) AS repurchased_90,
            COUNTIF(second_d IS NOT NULL) AS repurchased_any,
            APPROX_QUANTILES(gap, 2)[SAFE_OFFSET(1)] AS median_gap
          FROM eligible90) AS summary,
        ARRAY(SELECT AS STRUCT title, new_customers, repurchased_90 FROM firstitems
              WHERE new_customers >= 5 ORDER BY new_customers DESC LIMIT 20) AS first_products,
        (SELECT FORMAT_DATE('%Y-%m-%d', MIN(d)) FROM allo) AS data_since
      )) AS j`;
    return queryJson_(sql, {});
  }, 3 * 3600);
}

/* ------------------------------------------------------------------ */
/* 分眾名單                                                             */
/* ------------------------------------------------------------------ */

/** 篩選條件的選項（會員級別、年齡層、熱門商品…） */
function getSegmentOptions(siteKey) {
  const t = tableRef_(siteKey);
  const crm = crmRef_();
  const tb = siteTables_(siteKey);
  const key = 'segopt3:' + siteKey;
  const cache = CacheService.getUserCache();
  const hit = cache.get(key);
  if (hit) return JSON.parse(hit);

  const out = {
    concerns: CONFIG.CONCERNS[siteKey] || {},
    promoKeywords: CONFIG.PROMO_KEYWORDS,
    memberParam: CONFIG.MEMBER_URL_PARAM,
    membersReady: true,
  };
  try {
    const m = queryJson_(`
      WITH m AS (SELECT * FROM ${crm(tb.members)})
      SELECT TO_JSON_STRING(STRUCT(
        (SELECT COUNT(*) FROM m) AS total,
        ARRAY(SELECT AS STRUCT CAST(tier AS STRING) AS v, COUNT(*) AS n FROM m WHERE tier IS NOT NULL GROUP BY v ORDER BY n DESC) AS tiers,
        ARRAY(SELECT AS STRUCT CAST(gender AS STRING) AS v, COUNT(*) AS n FROM m WHERE gender IS NOT NULL GROUP BY v ORDER BY n DESC) AS genders,
        ARRAY(SELECT AS STRUCT CAST(age_band AS STRING) AS v, COUNT(*) AS n FROM m WHERE age_band IS NOT NULL GROUP BY v ORDER BY v) AS ageBands,
        ARRAY(SELECT AS STRUCT CAST(signup_utm_source AS STRING) AS v, COUNT(*) AS n FROM m WHERE signup_utm_source IS NOT NULL GROUP BY v ORDER BY n DESC LIMIT 30) AS sources,
        ARRAY(SELECT AS STRUCT TRIM(tag) AS v, COUNT(*) AS n FROM m, UNNEST(SPLIT(IFNULL(CAST(tags AS STRING), ''), ',')) AS tag
              WHERE TRIM(tag) != '' GROUP BY v ORDER BY n DESC LIMIT 40) AS tags
      )) AS j`, {});
    Object.assign(out, m);
    if (tb.hasSkin) {
      out.skinTypes = queryJson_(`
        SELECT TO_JSON_STRING(ARRAY(
          SELECT AS STRUCT TRIM(x) AS v, COUNT(*) AS n
          FROM ${crm(tb.members)}, UNNEST(SPLIT(IFNULL(CAST(skin_type AS STRING), ''), ',')) AS x
          WHERE TRIM(x) != '' GROUP BY v ORDER BY n DESC)) AS j`, {}) || [];
    }
  } catch (e) {
    out.membersReady = false;
    out.membersError = String(e.message || e);
  }
  try {
    const since = daysAgo_(180);
    out.products = queryJson_(`
      SELECT TO_JSON_STRING(ARRAY(
        SELECT AS STRUCT i.item_name AS v, COUNT(*) AS n
        FROM ${t} e, UNNEST(e.items) i
        WHERE _TABLE_SUFFIX >= @since AND e.event_name = 'view_item' AND i.item_name IS NOT NULL
        GROUP BY v ORDER BY n DESC LIMIT 150)) AS j`, { since: since }) || [];
  } catch (e) {
    out.products = [];
  }
  const s = JSON.stringify(out);
  if (s.length < 95000) { try { cache.put(key, s, 1800); } catch (e) {} }
  return out;
}

/**
 * 依條件篩選會員，回傳人數與名單。
 * f = {
 *   tiers[], genders[], ageBands[], sources[], tag, minOrders, maxOrders, minSpent, maxSpent,
 *   linePromoOnly, lineOnly,
 *   days,                      // 行為期間：最近 N 天
 *   keywords, minHits, excludeBought,   // 對特定商品／困擾有興趣
 *   promoMinHits,              // 對優惠敏感：至少瀏覽幾次優惠頁
 *   cartAbandon                // 加入購物車但沒購買
 * }
 */
function getSegment(siteKey, f) {
  f = f || {};
  const t = tableRef_(siteKey);
  const crm = crmRef_();
  const tb = siteTables_(siteKey);
  const p = {};
  const where = [];

  const strArr = function (a) {
    return (Array.isArray(a) ? a : []).map(String).filter(function (x) { return x && x.length <= 60; }).slice(0, 50);
  };
  const num = function (v, min, max) {
    if (v === '' || v == null) return null;
    const x = Number(v);
    if (!isFinite(x)) return null;
    return Math.max(min, Math.min(max, Math.round(x)));
  };

  // ---- 會員屬性 ----
  const arrFilters = [['tiers', 'tier'], ['genders', 'gender'], ['ageBands', 'age_band'], ['sources', 'signup_utm_source']];
  arrFilters.forEach(function (x) {
    const v = strArr(f[x[0]]);
    if (v.length) { p[x[0]] = v; where.push(`CAST(m.${x[1]} AS STRING) IN UNNEST(@${x[0]})`); }
  });
  const skins = strArr(f.skinTypes);
  if (skins.length && tb.hasSkin) {
    p.skinTypes = skins;
    where.push(`EXISTS (SELECT 1 FROM UNNEST(SPLIT(IFNULL(CAST(m.skin_type AS STRING), ''), ',')) AS x WHERE TRIM(x) IN UNNEST(@skinTypes))`);
  }
  if (f.tag && String(f.tag).trim()) {
    p.tag = String(f.tag).trim().slice(0, 60);
    where.push(`STRPOS(IFNULL(CAST(m.tags AS STRING), ''), @tag) > 0`);
  }
  const minOrders = num(f.minOrders, 0, 100000), maxOrders = num(f.maxOrders, 0, 100000);
  const minSpent = num(f.minSpent, 0, 1e9), maxSpent = num(f.maxSpent, 0, 1e9);
  if (minOrders != null) { p.minOrders = minOrders; where.push(`IFNULL(SAFE_CAST(m.orders AS INT64), 0) >= @minOrders`); }
  if (maxOrders != null) { p.maxOrders = maxOrders; where.push(`IFNULL(SAFE_CAST(m.orders AS INT64), 0) <= @maxOrders`); }
  if (minSpent != null) { p.minSpent = minSpent; where.push(`IFNULL(SAFE_CAST(m.total_spent AS INT64), 0) >= @minSpent`); }
  if (maxSpent != null) { p.maxSpent = maxSpent; where.push(`IFNULL(SAFE_CAST(m.total_spent AS INT64), 0) <= @maxSpent`); }
  if (f.linePromoOnly) where.push(`UPPER(CAST(m.accept_line_promo AS STRING)) IN ('Y', 'TRUE')`);

  // ---- 瀏覽行為 ----
  const days = num(f.days, 1, CONFIG.MAX_RANGE_DAYS) || 30;
  p.bstart = daysAgo_(days);
  p.bend = daysAgo_(0);

  const kws = String(f.keywords || '').split(/[,，、\n]/).map(function (s) { return s.trim().toLowerCase(); })
    .filter(function (s) { return s; }).slice(0, 40);
  p.kw = kws.length ? kws.map(reEscape_).join('|') : NO_MATCH_;
  p.promo = CONFIG.PROMO_KEYWORDS.map(function (s) { return reEscape_(s.toLowerCase()); }).join('|');
  if (kws.length) {
    p.minHits = num(f.minHits, 1, 1000) || 1;
    where.push(`IFNULL(b.kw_hits, 0) >= @minHits`);
    if (f.excludeBought) where.push(`IFNULL(b.kw_bought, 0) = 0 AND IFNULL(so.kw_orders, 0) = 0`);
  }
  const promoMin = num(f.promoMinHits, 0, 1000);
  if (promoMin) { p.promoMin = promoMin; where.push(`IFNULL(b.promo_hits, 0) >= @promoMin`); }
  // 「沒購買」以 SHOPLINE 實際訂單為準（GA4 會漏記部分訂單），GA4 有記到購買的也排除
  if (f.cartAbandon) where.push(`IFNULL(b.carts, 0) > 0 AND IFNULL(b.purchases, 0) = 0 AND IFNULL(so.orders_n, 0) = 0`);
  if (f.lineOnly) where.push(`l.line_uid IS NOT NULL`);

  const param = /^[A-Za-z_][A-Za-z0-9_]{0,30}$/.test(CONFIG.MEMBER_URL_PARAM) ? CONFIG.MEMBER_URL_PARAM : 'mid';

  const build = function (withLine) {
    return `
    WITH
    -- 裝置 → 會員：登入過的裝置，加上從推播連結 ?${param}= 辨識出來的裝置
    ident AS (
      SELECT user_pseudo_id, customer_id FROM (
        SELECT user_pseudo_id, user_id AS customer_id
        FROM ${t} WHERE _TABLE_SUFFIX >= '20200101' AND user_id IS NOT NULL
        UNION ALL
        SELECT user_pseudo_id,
          REGEXP_EXTRACT((SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'page_location'),
                         r'[?&]${param}=([A-Za-z0-9_-]{6,64})') AS customer_id
        FROM ${t} WHERE _TABLE_SUFFIX >= '20200101' AND event_name = 'page_view'
      )
      WHERE customer_id IS NOT NULL
      GROUP BY user_pseudo_id, customer_id
      -- 同一台裝置對應到超過 2 個會員（共用電腦、連結被轉傳）就不採用
      QUALIFY COUNT(*) OVER (PARTITION BY user_pseudo_id) <= 2
    ),
    ev AS (
      SELECT user_pseudo_id, event_name,
        LOWER(CONCAT(IFNULL(pt, ''), ' ', IFNULL(pl, ''), ' ', IFNULL(st, ''), ' ', IFNULL(names, ''))) AS txt
      FROM (
        SELECT user_pseudo_id, event_name,
          (SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'page_title') AS pt,
          (SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'page_location') AS pl,
          (SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'search_term') AS st,
          ARRAY_TO_STRING(ARRAY(SELECT IFNULL(i.item_name, '') FROM UNNEST(items) i), ' ') AS names
        FROM ${t}
        WHERE _TABLE_SUFFIX BETWEEN @bstart AND @bend
          AND event_name IN ('page_view', 'view_item', 'select_item', 'add_to_cart', 'view_search_results',
                             'search', 'begin_checkout', 'purchase')
      )
    ),
    beh AS (
      SELECT i.customer_id,
        COUNTIF(event_name IN ('page_view', 'view_item', 'select_item', 'add_to_cart', 'view_search_results', 'search')
                AND REGEXP_CONTAINS(txt, @kw)) AS kw_hits,
        COUNTIF(event_name = 'purchase' AND REGEXP_CONTAINS(txt, @kw)) AS kw_bought,
        COUNTIF(event_name = 'page_view' AND REGEXP_CONTAINS(txt, @promo)) AS promo_hits,
        COUNTIF(event_name = 'add_to_cart') AS carts,
        COUNTIF(event_name = 'purchase') AS purchases,
        COUNTIF(event_name = 'page_view') AS pageviews
      FROM ev JOIN ident i USING (user_pseudo_id)
      GROUP BY customer_id
    ),
    -- 行為期間內的 SHOPLINE 實際訂單（排除已取消）
    so AS (
      ${tb.orders && tb.items ? `
      SELECT o.customer_id,
        COUNT(DISTINCT o.order_id) AS orders_n,
        COUNT(DISTINCT IF(REGEXP_CONTAINS(LOWER(IFNULL(i.title, '')), @kw), o.order_id, NULL)) AS kw_orders
      FROM ${crm(tb.orders)} o LEFT JOIN ${crm(tb.items)} i USING (order_id)
      WHERE o.customer_id IS NOT NULL AND IFNULL(o.status, '') NOT IN ('cancelled', 'removed')
        AND FORMAT_DATE('%Y%m%d', DATE(o.created_at, '${CONFIG.TIMEZONE}')) >= @bstart
      GROUP BY o.customer_id` : `SELECT CAST(NULL AS STRING) AS customer_id, 0 AS orders_n, 0 AS kw_orders`}
    ),
    res AS (
      SELECT
        CAST(m.customer_id AS STRING) AS customer_id,
        ${withLine ? 'l.line_uid' : 'CAST(NULL AS STRING)'} AS line_uid,
        CAST(m.tier AS STRING) AS tier,
        IFNULL(SAFE_CAST(m.orders AS INT64), 0) AS orders,
        IFNULL(SAFE_CAST(m.total_spent AS INT64), 0) AS total_spent,
        CAST(m.gender AS STRING) AS gender,
        CAST(m.age_band AS STRING) AS age_band,
        CAST(m.signup_utm_source AS STRING) AS signup_source,
        CAST(m.tags AS STRING) AS tags,
        ${tb.hasSkin ? 'CAST(m.skin_type AS STRING)' : 'CAST(NULL AS STRING)'} AS skin_type,
        IFNULL(b.pageviews, 0) AS pageviews,
        IFNULL(b.kw_hits, 0) AS kw_hits,
        IFNULL(b.promo_hits, 0) AS promo_hits,
        IFNULL(b.carts, 0) AS carts,
        GREATEST(IFNULL(so.orders_n, 0), IFNULL(b.purchases, 0)) AS purchases
      FROM ${crm(tb.members)} m
      LEFT JOIN beh b ON b.customer_id = CAST(m.customer_id AS STRING)
      LEFT JOIN so ON so.customer_id = CAST(m.customer_id AS STRING)
      ${withLine ? `LEFT JOIN (SELECT CAST(customer_id AS STRING) AS customer_id, ANY_VALUE(CAST(line_uid AS STRING)) AS line_uid
                    FROM ${crm(tb.lineMap)} GROUP BY 1) l ON l.customer_id = CAST(m.customer_id AS STRING)` : ''}
      ${where.length ? 'WHERE ' + where.join('\n        AND ') : ''}
    )
    SELECT TO_JSON_STRING(STRUCT(
      (SELECT COUNT(*) FROM res) AS total,
      (SELECT COUNTIF(line_uid IS NOT NULL) FROM res) AS with_line,
      (SELECT COUNTIF(pageviews > 0) FROM res) AS with_behavior,
      ARRAY(SELECT AS STRUCT * FROM res
            ORDER BY kw_hits DESC, promo_hits DESC, total_spent DESC LIMIT 20000) AS member_list
    )) AS j`;
  };

  let result, lineReady = true;
  try {
    result = queryJson_(build(true), p, { raw: true });
  } catch (e) {
    const msg = String(e.message || e);
    if (msg.indexOf(tb.lineMap) >= 0) {
      if (f.lineOnly) throw new Error('還沒有上傳 LINE 對照表（' + CONFIG.CRM_DATASET + '.' + tb.lineMap + '），無法篩選「只要有 LINE ID 的會員」。');
      lineReady = false;
      result = queryJson_(build(false), p);
    } else if (msg.indexOf(tb.members) >= 0 && /Not found/i.test(msg)) {
      throw new Error('找不到會員資料表 ' + CONFIG.CRM_DATASET + '.' + tb.members + '，請先把這個品牌的會員資料上傳到 BigQuery。');
    } else {
      throw new Error(friendlyError_(e));
    }
  }
  result = result || { total: 0, with_line: 0, with_behavior: 0 };
  result.rows = result.member_list || [];
  delete result.member_list;
  result.lineReady = lineReady;
  result.window = { start: p.bstart, end: p.bend, days: days };
  return result;
}

const NO_MATCH_ = '\\x{10FFFF}\\x{10FFFE}';

function reEscape_(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function daysAgo_(n) {
  return Utilities.formatDate(new Date(Date.now() - n * 86400000), CONFIG.TIMEZONE, 'yyyyMMdd');
}

function siteTables_(siteKey) {
  const s = site_(siteKey);
  const ok = function (x) { return /^[A-Za-z0-9_]+$/.test(x || ''); };
  return {
    members: ok(s.members) ? s.members : 'members', lineMap: ok(s.lineMap) ? s.lineMap : 'line_map', hasSkin: !!s.hasSkin,
    orders: ok(s.orders) ? s.orders : null, items: ok(s.items) ? s.items : null,
    promos: ok(s.promos) ? s.promos : null,
  };
}

function crmRef_() {
  if (!/^[A-Za-z0-9_]+$/.test(CONFIG.CRM_DATASET)) throw new Error('CRM_DATASET 設定不正確');
  return function (table) {
    return '`' + CONFIG.PROJECT_ID + '.' + CONFIG.CRM_DATASET + '.' + table + '`';
  };
}

/* ------------------------------------------------------------------ */
/* SQL 共用片段                                                         */
/* ------------------------------------------------------------------ */

function evCte_(t) {
  return `ev AS (
    SELECT
      event_date,
      event_timestamp,
      event_name,
      user_pseudo_id,
      user_id,
      device_cat,
      sid,
      IF(sid IS NULL, NULL, CONCAT(user_pseudo_id, '.', CAST(sid AS STRING))) AS sess,
      page_location,
      page_title,
      eng_ms,
      IF(NET.HOST(page_referrer) = NET.HOST(page_location), NULL, NET.HOST(page_referrer)) AS ref_host,
      cts_source, cts_medium, gclid, revenue
    FROM (
      -- 只選需要的欄位，降低 BigQuery 掃描量（費用）
      SELECT
        event_date, event_timestamp, event_name, user_pseudo_id, user_id,
        device.category AS device_cat,
        (SELECT value.int_value FROM UNNEST(event_params) WHERE key = 'ga_session_id') AS sid,
        (SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'page_location') AS page_location,
        (SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'page_title') AS page_title,
        (SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'page_referrer') AS page_referrer,
        (SELECT COALESCE(value.int_value, CAST(value.double_value AS INT64))
           FROM UNNEST(event_params) WHERE key = 'engagement_time_msec') AS eng_ms,
        collected_traffic_source.manual_source AS cts_source,
        collected_traffic_source.manual_medium AS cts_medium,
        collected_traffic_source.gclid AS gclid,
        ecommerce.purchase_revenue AS revenue
      FROM ${t}
      WHERE _TABLE_SUFFIX BETWEEN @start AND @end
    )
  )`;
}

/** 依來源 / 媒介 / 參照網址把工作階段歸類到管道 */
/** 結帳途中跳去的外部頁（超商門市地圖、金流、3D 驗證）。這些不是流量來源，
 *  從這裡回到官網的工作階段會沿用同一裝置上一次的來源。 */
function checkoutRedirectRe_() {
  return "r'unipcsc|pcsc\\.com|presco|map\\.com\\.tw|family\\.com\\.tw|hilife|okmart|ecpay|allpay|newebpay|spgateway|pay\\.line\\.me|linepay|line_pay|line-pay|jkopay|jkos|tappay|paypal|shoplinepay|pxpay|3ds|cardinalcommerce|bank'";
}
function channelCase_() {
  return `CASE
    WHEN has_gclid OR (REGEXP_CONTAINS(IFNULL(src, ''), r'google')
         AND REGEXP_CONTAINS(IFNULL(med, ''), r'^(cpc|ppc|paid.*)$'))
         OR REGEXP_CONTAINS(IFNULL(src, ''), r'pmax|google_?ads') THEN 'Google 廣告'
    WHEN REGEXP_CONTAINS(IFNULL(src, ''), r'line_?-?shop') THEN 'LINE 購物'
    WHEN (REGEXP_CONTAINS(IFNULL(src, ''), r'^line|[^a-z]line|line\\.me|liff')
          AND NOT REGEXP_CONTAINS(IFNULL(src, ''), r'linepay|line_pay|line-pay'))
         OR REGEXP_CONTAINS(IFNULL(ref, ''), r'line\\.me|liff') THEN 'LINE'
    WHEN REGEXP_CONTAINS(IFNULL(src, ''), r'kol|groupbuy|blog|beauty|influencer') THEN 'KOL / 媒體'
    WHEN has_fbclid
         OR REGEXP_CONTAINS(IFNULL(src, ''), r'facebook|instagram|threads|^fb|^ig|^meta')
         OR REGEXP_CONTAINS(IFNULL(ref, ''), r'facebook\\.com|instagram\\.com|threads\\.net') THEN 'Facebook / IG'
    WHEN REGEXP_CONTAINS(IFNULL(src, ''), r'google')
         OR REGEXP_CONTAINS(IFNULL(ref, ''), r'(^|\\.)google\\.') THEN 'Google 搜尋'
    WHEN REGEXP_CONTAINS(IFNULL(med, ''), r'mail|edm|newsletter')
         OR REGEXP_CONTAINS(IFNULL(src, ''), r'^e?-?mail$|edm|newsletter') THEN '電子報'
    WHEN REGEXP_CONTAINS(CONCAT(IFNULL(src, ''), IFNULL(ref, '')), r'yahoo|bing|duckduckgo|baidu') THEN '其他搜尋'
    WHEN (src IS NULL OR src = '(direct)') AND ref IS NULL THEN '直接造訪'
    ELSE '其他'
  END`;
}

/* ------------------------------------------------------------------ */
/* 工具函式                                                             */
/* ------------------------------------------------------------------ */

function site_(siteKey) {
  const s = CONFIG.SITES.filter(function (x) { return x.key === siteKey; })[0];
  if (!s) throw new Error('找不到網站設定：' + siteKey);
  if (!isDatasetReady_(s.dataset)) {
    throw new Error('「' + s.name + '」的 BigQuery dataset 還沒設定，請在 Code.gs 的 CONFIG.SITES 填入 analytics_ 開頭的名稱。');
  }
  return s;
}

function isDatasetReady_(ds) {
  return /^analytics_\d+$/.test(ds || '');
}

function tableRef_(siteKey) {
  const s = site_(siteKey);
  return '`' + CONFIG.PROJECT_ID + '.' + s.dataset + '.events_*`';
}

function rangeParams_(start, end) {
  const re = /^\d{4}-\d{2}-\d{2}$/;
  if (!re.test(start) || !re.test(end)) throw new Error('日期格式不正確');
  if (start > end) throw new Error('開始日期不能晚於結束日期');
  const days = (new Date(end) - new Date(start)) / 86400000;
  if (days > CONFIG.MAX_RANGE_DAYS) throw new Error('日期區間最多 ' + CONFIG.MAX_RANGE_DAYS + ' 天');
  return { start: start.replace(/-/g, ''), end: end.replace(/-/g, '') };
}

/** 彙總報表加上個人快取（每個使用者各自一份，避免沒有權限的人讀到快取） */
function cached_(kind, siteKey, start, end, fn, seconds) {
  const t = tableRef_(siteKey);
  const p = rangeParams_(start, end);
  const key = [kind, siteKey, p.start, p.end].join(':');
  const cache = CacheService.getUserCache();
  const hit = cache.get(key);
  if (hit) return JSON.parse(hit);
  const result = fn(t, p);
  const s = JSON.stringify(result);
  if (s.length < 95000) {
    try { cache.put(key, s, seconds || CONFIG.CACHE_SECONDS); } catch (e) { /* 太大就不快取 */ }
  }
  return result;
}

/** 執行回傳單一 JSON 欄位 j 的查詢 */
function queryJson_(sql, params, opts) {
  const rows = runQuery_(sql, params, opts);
  if (!rows.length || rows[0].j == null) return null;
  return JSON.parse(rows[0].j);
}

function runQuery_(sql, params, opts) {
  const req = {
    query: sql,
    useLegacySql: false,
    location: CONFIG.LOCATION,
    maximumBytesBilled: CONFIG.MAX_BYTES_BILLED,
    timeoutMs: 60000,
  };
  const names = Object.keys(params || {});
  if (names.length) {
    req.parameterMode = 'NAMED';
    req.queryParameters = names.map(function (k) {
      const v = params[k];
      if (Array.isArray(v)) {
        return {
          name: k,
          parameterType: { type: 'ARRAY', arrayType: { type: 'STRING' } },
          parameterValue: { arrayValues: v.map(function (x) { return { value: String(x) }; }) },
        };
      }
      return {
        name: k,
        parameterType: { type: typeof v === 'number' ? 'INT64' : 'STRING' },
        parameterValue: { value: String(v) },
      };
    });
  }

  let res;
  try {
    res = BigQuery.Jobs.query(req, CONFIG.PROJECT_ID);
    const jobId = res.jobReference.jobId;
    let wait = 500;
    while (!res.jobComplete) {
      Utilities.sleep(wait);
      wait = Math.min(wait * 2, 4000);
      res = BigQuery.Jobs.getQueryResults(CONFIG.PROJECT_ID, jobId,
        { location: CONFIG.LOCATION, timeoutMs: 60000 });
    }
    let rows = res.rows || [];
    let token = res.pageToken;
    while (token) {
      const page = BigQuery.Jobs.getQueryResults(CONFIG.PROJECT_ID, jobId,
        { location: CONFIG.LOCATION, pageToken: token });
      rows = rows.concat(page.rows || []);
      token = page.pageToken;
    }
    const fields = res.schema.fields;
    return rows.map(function (r) {
      const o = {};
      r.f.forEach(function (c, i) { o[fields[i].name] = c.v; });
      return o;
    });
  } catch (e) {
    if (opts && opts.raw) throw e;
    throw new Error(friendlyError_(e));
  }
}

function friendlyError_(e) {
  const msg = String((e && e.message) || e);
  if (/Not found: (Table|Dataset)|does not match any table/i.test(msg)) {
    return '這段期間在 BigQuery 裡沒有資料。GA4 每日匯出通常隔天才會進來，請換一個日期區間試試。';
  }
  if (/Access Denied|permission|does not have/i.test(msg)) {
    return '你的帳號沒有這個 BigQuery 專案的權限，請管理員在 Google Cloud「IAM」加入「BigQuery 資料檢視者」和「BigQuery 工作使用者」角色。';
  }
  if (/bytes billed|maximumBytesBilled/i.test(msg)) {
    return '這個查詢掃描的資料量超過上限，請縮短日期區間。';
  }
  return 'BigQuery 查詢失敗：' + msg;
}
