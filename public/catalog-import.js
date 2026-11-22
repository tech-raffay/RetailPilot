import {ctx,api,btn,esc,form,localStore,modal,money,selectField,table} from './core.js';

export function catalogImportForm() {
  const stores = ctx.s.stores.map(s => [s.id,s.name]);
  const body = '<p>Upload one row per new variant. Prices are in GBP. Opening stock goes to the selected store.</p>'+
    '<p><a href="/catalog-template.csv" download>Download sample CSV</a></p>'+
    selectField('Opening stock location','store',stores,localStore())+
    '<label class="field">CSV file<input name="csvFile" type="file" accept=".csv,text/csv" required></label>'+
    '<small>UTF-8 CSV, up to 500 rows and 256 KiB.</small>';
  modal('Import catalog CSV',form('catalogPreview',body,'Preview import'));
}

export async function previewCatalogFile(upload) {
  const file = upload.elements.csvFile.files[0];
  if (!file || file.size > 262144) throw new Error('Choose a CSV file up to 256 KiB.');
  let csv;
  try { csv = new TextDecoder('utf-8',{fatal:true}).decode(await file.arrayBuffer()); }
  catch { throw new Error('Save the file as a UTF-8 CSV and try again.'); }
  const store = upload.elements.store.value;
  const result = await api('products/import/preview',{csv,store});
  if (!upload.isConnected) return;
  if (result.alreadyImported) {
    modal('Already imported','<p>This file has already imported '+result.count+' products at this store.</p>'+btn('Close','close'));
    return;
  }
  const invalid = result.rows.filter(row => row.errors.length).length;
  const location = ctx.s.stores.find(s=>s.id===store);
  const summary = '<p>'+esc(file.name)+' · '+esc(location?.name)+' · '+result.rows.length+' product rows</p>';
  const grid = table(['CSV line','SKU','Product','Price','Opening stock','Validation'],result.rows.map(({line,product,errors})=>
    '<tr><td>'+line+'</td><td>'+esc(product.sku)+'</td><td>'+esc(product.name)+'</td><td>'+
    (Number.isFinite(product.price)?money(product.price):'—')+'</td><td>'+esc(product.quantity)+'</td><td>'+
    esc(errors.join(' ')||'Ready')+'</td></tr>'));
  const changeFile = btn('Choose another file','catalogImportForm','','secondary','type="button"');
  if (invalid) {
    modal('Review catalog import',summary+'<p>Correct '+invalid+' invalid '+(invalid===1?'row':'rows')+' and upload again.</p>'+grid+changeFile,true);
    return;
  }
  const count=result.rows.length;
  modal('Review catalog import',form('catalogCommit',summary+grid,'Import '+count+' '+(count===1?'product':'products'),changeFile),true);
  document.querySelector('form[data-form="catalogCommit"]').importPayload = {csv,store,preview:result.preview};
}
