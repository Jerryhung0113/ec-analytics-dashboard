-- 身分串接：把「匿名裝置」對回「會員」
-- GA4 每個事件都有 user_pseudo_id（裝置），登入後才有 user_id（會員）。
-- 只要這台裝置曾經登入過，就把它登入前的瀏覽也歸給同一位會員。
-- 一台裝置對到 3 位以上會員（公用電腦、門市平板）視為不可靠，直接忽略。
WITH pairs AS (
  SELECT user_pseudo_id, user_id
  FROM `your-gcp-project.analytics_111111111.events_*`
  WHERE _TABLE_SUFFIX BETWEEN @start AND @end
    AND user_id IS NOT NULL
  GROUP BY user_pseudo_id, user_id
),
device_map AS (
  SELECT user_pseudo_id, ANY_VALUE(user_id) AS member_id
  FROM pairs
  GROUP BY user_pseudo_id
  HAVING COUNT(*) <= 2
)
SELECT
  e.event_date,
  COALESCE(e.user_id, m.member_id) AS member_id,   -- 事件本身有就用，沒有就用裝置對照
  e.user_pseudo_id,
  e.event_name
FROM `your-gcp-project.analytics_111111111.events_*` e
LEFT JOIN device_map m USING (user_pseudo_id)
WHERE _TABLE_SUFFIX BETWEEN @start AND @end;
