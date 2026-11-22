import {change,fail,storeFor} from './business.js';

const requiredColumns = ['sku','name','category','price'];
const catalogColumns = [...requiredColumns,'barcode','cost','quantity','threshold','tax','size','color','image_url'];

function csvRecords(text) {
  if (typeof text !== 'string' || new TextEncoder().encode(text).length > 262144) {
    fail('Choose a UTF-8 CSV file up to 256 KiB.');
  }
  const source = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const records = [];
  let cells = [], value = '', quoted = false, closed = false, line = 1, start = 1;
  for (let i = 0; i <= source.length; i++) {
    const c = source[i];
    if (quoted) {
      if (c === undefined) fail('Line '+start+': unclosed quoted field.');
      if (c === '"' && source[i+1] === '"') { value += '"'; i++; continue; }
      if (c === '"') { quoted = false; closed = true; continue; }
      if (c === '\n') line++;
      value += c;
    } else if (c === ',' || c === '\n' || c === undefined) {
      cells.push(value.trim());
      value = '';
      closed = false;
      if (c === ',') continue;
      if (cells.length > 1 || cells[0]) records.push({line:start, cells});
      if (records.length > 501) fail('Import up to 500 product rows at a time.');
      cells = [];
      start = ++line;
    } else if (c === '"' && !value && !closed) {
      quoted = true;
    } else {
      if (closed || c === '"') fail('Line '+start+': invalid quotation. Quote the entire field and double any internal quotes.');
      value += c;
    }
  }
  return records;
}

export function planCatalogImport(s, text, store) {
  storeFor(s, store);
  const [header, ...records] = csvRecords(text);
  const columns = header?.cells.map(c => c.toLowerCase()) || [];
  const missing = requiredColumns.filter(c => !columns.includes(c));
  if (missing.length) fail('Missing columns: '+missing.join(', ')+'.');
  if (new Set(columns).size !== columns.length) fail('Each column heading must be unique.');
  const unknown = columns.filter(c => !catalogColumns.includes(c));
  if (unknown.length) fail('Unrecognized column: '+unknown.join(', ')+'. Use the sample headers.');
  if (!records.length) fail('The CSV has no product rows.');
  const skus = new Set(s.products.map(p => p.sku.toLowerCase()));
  const barcodes = new Set(s.products.map(p => p.barcode).filter(Boolean));
  const rows = records.map(({line,cells}) => {
    const data = Object.fromEntries(columns.map((key,i) => [key,cells[i] || '']));
    const errors = [];
    if (cells.length !== columns.length) errors.push('Column count differs from header.');
    for (const key of requiredColumns) if (!data[key]) errors.push(key+' is required.');
    for (const [key,value] of Object.entries(data)) {
      if (value.length > (key === 'image_url' ? 1000 : 120)) errors.push(key+' is too long.');
    }
    const sku = data.sku.toLowerCase();
    if (sku && skus.has(sku)) errors.push('SKU already exists in the catalog or an earlier row.');
    if (data.barcode && barcodes.has(data.barcode)) errors.push('Barcode already exists in the catalog or an earlier row.');
    skus.add(sku);
    if (data.barcode) barcodes.add(data.barcode);
    function amount(key) {
      const raw = data[key] || '0';
      if (!/^\d+(\.\d{1,2})?$/.test(raw) || Number(raw) > 999999.99) errors.push(key+' must be a GBP amount from 0 to 999999.99 with up to two decimal places.');
      return Math.round(Number(raw)*100);
    }
    function integer(key, fallback, max) {
      const raw = data[key] || String(fallback);
      if (!/^\d+$/.test(raw) || Number(raw)>max) errors.push(key+' must be a whole number from 0 to '+max+'.');
      return Number(raw);
    }
    if (data.image_url) {
      try { if (new URL(data.image_url).protocol !== 'https:' || !data.image_url.startsWith('https://')) throw Error(); }
      catch { errors.push('image_url must be an HTTPS URL.'); }
    }
    const product = {sku:data.sku,name:data.name,category:data.category,barcode:data.barcode||'',size:data.size||'',
      color:data.color||'',imageUrl:data.image_url||'',store,price:amount('price'),cost:amount('cost'),
      quantity:integer('quantity',0,999999),threshold:integer('threshold',5,99999),tax:integer('tax',s.vat,100)};
    return {line,product,errors};
  });
  return {rows,valid:rows.every(row => row.errors.length === 0)};
}

export function commitCatalogImport(s, text, store, member, key, previewVat) {
  const previous = s.catalogImports?.[key];
  if (previous) return {count:previous.count,alreadyImported:true};
  const plan = planCatalogImport(s,text,store);
  if (!plan.valid) fail('The catalog or CSV has conflicts. Preview the file again.',409);
  if (previewVat !== s.vat) fail('The default VAT changed. Preview the file again.',409);
  for (const row of plan.rows) change(s,'product',row.product,member);
  s.catalogImports ??= {};
  s.catalogImports[key] = {count:plan.rows.length};
  return {count:plan.rows.length,alreadyImported:false};
}
