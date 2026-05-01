/**
 * 同步 x_qty_per_box → Odoo website custom_code_head JS
 * 讓 Robby 在 Odoo 後台改 x_qty_per_box 後，執行此腳本即可同步到網站前端
 * 
 * Usage: node sync_qty_per_box_to_website.cjs
 */
const { odooCall } = require('../lib/odoo.cjs');

async function sync() {
  console.log('[sync] 讀取 product.template x_qty_per_box...');
  
  // 讀取所有有 x_qty_per_box 的 template
  const templates = await odooCall('product.template', 'search_read',
    [[['x_qty_per_box', '>', 1], ['sale_ok', '=', true]]],
    { fields: ['id', 'name', 'x_qty_per_box'] });
  
  // 讀取 product.product 的 variant ID（用於購物車驗證）
  const products = await odooCall('product.product', 'search_read',
    [[['product_tmpl_id', 'in', templates.map(t => t.id)]]],
    { fields: ['id', 'product_tmpl_id', 'x_qty_per_box'] });
  
  // Build maps
  const T = {}; // template_id → qty
  const P = {}; // product_id → qty
  
  templates.forEach(t => { T[t.id] = t.x_qty_per_box; });
  products.forEach(p => { 
    const tmplId = Array.isArray(p.product_tmpl_id) ? p.product_tmpl_id[0] : p.product_tmpl_id;
    const tmpl = templates.find(t => t.id === tmplId);
    if (tmpl) P[p.id] = tmpl.x_qty_per_box;
  });
  
  console.log(`[sync] ${Object.keys(T).length} templates, ${Object.keys(P).length} products`);
  
  // Build JS
  const js = `<!-- PaoMao 箱/組倍數驗證 -->
<script>
(function(){
  var T=${JSON.stringify(T)};
  var P=${JSON.stringify(P)};
  function getTid(){
    var el=document.querySelector('[data-oe-model="product.template"]');
    if(el)return parseInt(el.dataset.oeId);
    var m=window.location.pathname.match(/-(\\d+)(?:\\.html)?$/);
    return m?parseInt(m[1]):null;
  }
  function run(){
    var qi=document.querySelector('input[name="add_qty"]');
    if(qi){
      var tid=getTid(),bq=T[tid];
      if(bq&&bq>1){
        qi.setAttribute('step',bq);qi.setAttribute('min',bq);
        if(parseInt(qi.value)<bq)qi.value=bq;
        if(!qi.dataset.qtyBound){
          qi.dataset.qtyBound='1';
          var h=document.createElement('div');
          h.style.cssText='font-size:13px;color:#e67e22;margin-top:6px;font-weight:600;';
          h.textContent='\\u26a0\\ufe0f 此商品需以 '+bq+' 的倍數下單（每箱/組 '+bq+' 個）';
          qi.parentElement.appendChild(h);
          qi.addEventListener('change',function(){
            var v=parseInt(this.value)||0;
            if(v%bq!==0){var c=Math.max(bq,Math.round(v/bq)*bq);this.value=c;
              alert('此商品需以 '+bq+' 的倍數訂購，已自動調整為 '+c);}
          });
        }
      }
    }
    document.querySelectorAll('.js_quantity').forEach(function(inp){
      var pid=parseInt(inp.dataset.productId)||0;
      var bq=P[pid];
      if(bq&&bq>1){
        inp.setAttribute('step',bq);inp.setAttribute('min',bq);
        var v=parseInt(inp.value)||0;
        if(v>0&&v%bq!==0){
          inp.value=Math.max(bq,Math.round(v/bq)*bq);
          inp.dispatchEvent(new Event('change',{bubbles:true}));
        }
      }
    });
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',run);
  else setTimeout(run,500);
  new MutationObserver(function(){setTimeout(run,300)}).observe(document.body||document.documentElement,{childList:true,subtree:true});
})();
</script>
<!-- PaoMao 按鈕文字修改 -->
<script>
(function(){
  function fix(){
    document.querySelectorAll('button,a,.btn').forEach(function(el){
      if(el.textContent.trim()==='立即付款')el.textContent='確認下單';
    });
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',fix);
  else setTimeout(fix,300);
  new MutationObserver(function(){setTimeout(fix,200)}).observe(document.body||document.documentElement,{childList:true,subtree:true});
})();
</script>`;

  // 更新 website
  await odooCall('website', 'write', [[1], { custom_code_head: js }]);
  console.log('[sync] ✅ custom_code_head 已更新');
  
  // 顯示變更
  templates.forEach(t => console.log(`  ${t.name}: ${t.x_qty_per_box}`));
}

sync().catch(e => { console.error(e.message); process.exit(1); });
