-- 商品折扣後營收：把整張訂單的「實付金額」依各品項原價小計的比例分攤
-- 電商平台的折扣（組合價、滿額折、會員折扣）是掛在整張訂單上，
-- 直接加總品項原價會高估商品營收，所以用比例分攤回每個品項。
SELECT
  i.sku,
  ANY_VALUE(i.title) AS title,
  SUM(i.quantity) AS qty,
  ROUND(SUM(net)) AS net_revenue
FROM (
  SELECT i.*,
    SAFE_DIVIDE(i.total * o.total, SUM(i.total) OVER (PARTITION BY i.order_id)) AS net
  FROM `your-gcp-project.crm.order_items_brand_a` i
  JOIN `your-gcp-project.crm.orders_brand_a` o USING (order_id)
  WHERE IFNULL(o.status, '') NOT IN ('cancelled', 'removed')
) i
WHERE IFNULL(i.item_type, 'Product') != 'Gift'
GROUP BY i.sku
ORDER BY net_revenue DESC;
