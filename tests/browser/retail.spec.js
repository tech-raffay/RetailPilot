import { test, expect } from '@playwright/test';

test.beforeEach(async ({context}) => {
  // Exercise the local app and its print layout with the system font fallback.
  await context.route('https://fonts.googleapis.com/**', route => route.fulfill({contentType:'text/css',body:''}));
});

test('sales report prints the selected store, UTC dates and matching product totals', async ({page}) => {
  await page.setViewportSize({width:375,height:812});
  await page.goto('/#reports');
  await page.getByLabel('Store location').selectOption('manchester');
  await page.getByLabel('Reporting period').selectOption('30');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const {workspace} = await (await page.request.get('/api/state')).json();
  const end = new Date();
  end.setUTCHours(0,0,0,0);
  const start = +end - 29 * 86400000;
  const paid = workspace.orders.filter(o => o.store === 'manchester' && o.status === 'Paid'
    && o.date >= start && o.date < +end + 86400000);
  expect(paid.length).toBeGreaterThan(0);
  const amount = new Intl.NumberFormat('en-GB',{style:'currency', currency:'GBP'})
    .format(paid.reduce((sum,o) => sum + o.total,0) / 100);
  const units = paid.flatMap(o => o.items).reduce((sum,item) => sum + item.qty,0);
  await page.evaluate(() => { window.print = () => { window.printRequested = true; }; });
  await page.getByRole('button',{name:'Print / Save PDF'}).click();
  expect(await page.evaluate(() => window.printRequested)).toBe(true);
  await page.emulateMedia({media:'print'});
  const heading = page.locator('.report-print-heading');
  await expect(heading).toBeVisible();
  await expect(heading).toContainText(workspace.name + ' · Manchester');
  const format = new Intl.DateTimeFormat('en-GB',{day:'numeric',month:'short',year:'numeric',timeZone:'UTC'});
  await expect(heading).toContainText(format.format(start) + ' – ' + format.format(end) + ' (UTC)');
  await expect(page.locator('.summary-strip strong').first()).toHaveText(amount);
  const quantities = await page.locator('.sales-report tbody tr td:nth-child(2)').allTextContents();
  expect(quantities.reduce((sum,qty) => sum + Number(qty),0)).toBe(units);
  await expect(page.locator('.sidebar')).toBeHidden();
  await expect(page.getByRole('button',{name:'Print / Save PDF'})).toBeHidden();
  const pdf = await page.pdf({format:'A4'});
  expect(pdf.subarray(0,5).toString()).toBe('%PDF-');
});

test('welcome page opens independent owner and cashier demos and keeps workspace pricing consistent',async({page})=>{
  await page.goto('/welcome.html');
  const business=page.locator('article').filter({has:page.getByRole('heading',{name:'Business'})});
  await expect(business).toContainText('£99');
  await expect(business).toContainText('1,000 stores · 10,000 staff');
  expect(await page.locator('figure img').evaluate(img=>img.complete&&img.naturalWidth>0)).toBe(true);
  await page.getByRole('button',{name:'Explore owner demo'}).click();
  await expect(page).toHaveURL(/#overview$/);
  await page.getByRole('link',{name:'Billing & plans'}).click();
  await expect(page.locator('.plan').filter({hasText:'Business'})).toContainText('1,000 stores');
  await page.request.post('/api/adjust',{data:{product:'JKT-001',store:'london',delta:-5,reason:'Demo check'}});
  await page.getByRole('link',{name:'RetailPilot demo & pricing'}).click();
  await page.getByRole('button',{name:'Try cashier register'}).click();
  await expect(page).toHaveURL(/#pos$/);
  await expect(page.getByRole('heading',{name:'Point of sale'})).toBeVisible();
  const state=await (await page.request.get('/api/state')).json();
  expect(state.member.role).toBe('Cashier');
  expect(state.workspace.products.find(p=>p.sku==='JKT-001').stock.london).toBe(10);
});

test('mobile landing page handles demo errors and leads into local trial signup',async({page})=>{
  await page.setViewportSize({width:375,height:812});
  await page.goto('/welcome.html');
  await page.route('**/api/demo',r=>r.fulfill({status:503,body:'{}'}));
  await page.getByRole('button',{name:'Try cashier register'}).click();
  await expect(page.getByRole('status')).toContainText('Please try again');
  await expect(page.getByRole('button',{name:'Explore owner demo'})).toBeEnabled();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.unroute('**/api/demo');
  await page.getByRole('link',{name:'Start a Starter trial'}).click();
  await page.getByRole('link',{name:'Continue to sign in'}).click();
  await page.getByRole('link',{name:'Create account'}).click();
  await expect(page.getByRole('heading',{name:'Create account'})).toBeVisible();
});

test('cashier can scan and complete checkout using only the keyboard',async({page})=>{
  await page.request.post('/api/demo',{data:{role:'Cashier'}});
  await page.goto('/#pos');
  const search=page.getByRole('textbox',{name:'Find a product or scan barcode'});
  await expect(search).toBeVisible();
  await page.keyboard.press('F4');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  for(const code of ['JKT-001','5051100000000']){
    await page.keyboard.press('F2');
    await expect(search).toBeFocused();
    await page.keyboard.type(code);
    await page.keyboard.press('Enter');
    await expect(search).toHaveValue('');
  }
  await page.keyboard.press('F4');
  const dialog=page.getByRole('dialog',{name:'Checkout'});
  await expect(dialog).toContainText('£119.98');
  await page.keyboard.press('Control+k');
  await expect(dialog).toBeVisible();
  const confirm=dialog.getByRole('button',{name:'Confirm payment'});
  for(let i=0;i<8 && !(await confirm.evaluate(el=>el===document.activeElement));i++)await page.keyboard.press('Tab');
  await expect(confirm).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog',{name:/Order #/})).toContainText('Paid');
  await page.keyboard.press('Escape');
  await expect(search).toBeFocused();
});

test('customer form links to a readable mobile privacy notice',async({page})=>{
  await page.setViewportSize({width:375,height:812});
  await page.goto('/#customers');
  await page.getByRole('button',{name:'Add customer'}).click();
  const popup=page.waitForEvent('popup');
  await page.getByRole('dialog').getByRole('link',{name:'Customer privacy notice'}).click();
  const notice=await popup;
  await expect(notice.getByRole('heading',{name:'Customer privacy notice'})).toBeVisible();
  expect(await notice.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await expect(page.getByRole('dialog',{name:'Add customer'})).toBeVisible();
});

test('transfer updates both stores and links their movements',async({page})=>{
  await page.goto('/#inventory');
  await page.getByRole('button',{name:'Transfer stock'}).click();
  await page.getByLabel('Product variant').selectOption('JKT-001');
  await page.getByLabel('From store').selectOption('manchester');
  await expect(page.getByLabel('To store')).toHaveValue('london');
  await page.getByLabel('From store').selectOption('london');
  await expect(page.getByLabel('To store')).toHaveValue('manchester');
  await expect(page.getByText('10 units available at London.')).toBeVisible();
  await page.getByLabel('Units to transfer').fill('3');
  await page.getByRole('button',{name:'Confirm transfer'}).click();
  const outgoing=page.getByRole('row').filter({hasText:'Transfer out'});
  const incoming=page.getByRole('row').filter({hasText:'Transfer in'});
  await expect(outgoing.getByRole('cell').nth(2)).toHaveText('-3');
  await expect(incoming.getByRole('cell').nth(2)).toHaveText('+3');
  const ref=await outgoing.getByRole('cell').nth(4).innerText();
  expect(ref).toMatch(/^TR-/);
  await expect(incoming.getByRole('cell').nth(4)).toHaveText(ref);
  await page.getByRole('button',{name:'Stock levels'}).click();
  await page.getByLabel('Search inventory').fill('JKT-001');
  await expect(page.getByRole('row').filter({hasText:'London'}).getByRole('cell').nth(2)).toHaveText('7');
  await expect(page.getByRole('row').filter({hasText:'Manchester'}).getByRole('cell').nth(2)).toHaveText('6');
});

test('catalog CSV template previews, imports and opens stock once', async ({page}) => {
  await page.goto('/#products');
  const open = page.getByRole('button',{name:'Import CSV'});
  await open.click();
  const downloaded = page.waitForEvent('download');
  await page.getByRole('link',{name:'Download sample CSV'}).click();
  const template = await downloaded;
  expect(template.suggestedFilename()).toBe('catalog-template.csv');
  const path = await template.path();
  const file = page.getByLabel('CSV file');
  await file.setInputFiles({name:'invalid.csv',mimeType:'text/csv',buffer:Buffer.from('sku,name,price,category\nJKT-001,Existing,19,Coats')});
  await page.getByRole('button',{name:'Preview import'}).click();
  await expect(page.getByText(/SKU already exists/)).toBeVisible();
  await expect(page.getByRole('button',{name:'Import 1 product'})).toHaveCount(0);
  await page.getByRole('button',{name:'Choose another file'}).click();
  await page.getByLabel('Opening stock location').selectOption('manchester');
  await file.setInputFiles(path);
  await page.getByRole('button',{name:'Preview import'}).click();
  await expect(page.getByRole('dialog')).toContainText('Manchester');
  await page.getByRole('button',{name:'Import 1 product',exact:true}).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await page.getByRole('link',{name:/Inventory/}).click();
  await page.getByLabel('Store location').selectOption('manchester');
  await page.getByLabel('Search inventory').fill('SAMPLE-SHIRT-M');
  await expect(page.getByRole('row').filter({hasText:'Sample Shirt'}).getByRole('cell').nth(2)).toHaveText('10');
  await page.getByRole('link',{name:'Products',exact:true}).click();
  await open.click();
  await file.setInputFiles(path);
  await page.getByRole('button',{name:'Preview import'}).click();
  await expect(page.getByRole('heading',{name:'Already imported'})).toBeVisible();
});

test('owner can cancel or confirm customer profile removal', async ({ page }) => {
  await page.goto('/#customers');
  const row = page.getByRole('row').filter({ hasText: 'Amelia Brooks' });
  const remove = page.getByRole('button', { name: 'Remove profile' });
  await row.click();
  await remove.click();
  await page.getByRole('button', { name: 'Cancel' }).click();
  await row.click();
  await remove.click();
  await page.getByRole('button', { name: 'Confirm removal' }).click();
  await expect(row).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Customers', exact: true })).toBeVisible();
  await expect(row).toHaveCount(0);
});

test('owner downloads a customer profile from the customer list', async ({ page }) => {
  await page.goto('/#customers');
  const row = page.getByRole('row').filter({ hasText: 'Amelia Brooks' });
  await row.click();
  const download = page.waitForEvent('download');
  await page.getByRole('link', { name: 'Download customer data' }).click();
  const file = await download;
  expect(file.suggestedFilename()).toBe('customer-export.json');
  const chunks = [];
  for await (const chunk of await file.createReadStream()) chunks.push(chunk);
  const report = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  expect(report.customer.name).toBe('Amelia Brooks');
  expect(report.purchases.length).toBeGreaterThan(0);
});

test('London jacket sale produces a receipt and the return restores inventory', async ({ page }) => {
  await page.setViewportSize({width: 375, height: 812});
  await page.goto('/welcome.html');
  await page.getByRole('link', { name: 'See how a jacket sale updates stock' }).click();
  await expect(page.getByRole('heading', { name: 'Two jackets, one sale and a return.' })).toBeVisible();
  await expect(page.getByRole('table')).toContainText('Low stock');
  await expect.poll(() => page.locator('figure img').evaluate(img => img.naturalWidth)).toBeGreaterThan(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('button', { name: 'Try this sale in the demo' }).click();
  await expect(page).toHaveURL(/#pos$/);
  await page.setViewportSize({width: 1280, height: 800});
  await expect(page.getByLabel('Store location')).toHaveValue('london');
  const search = page.getByLabel('Find a product or scan barcode');
  await search.fill('JKT-001');
  const jacket = page.getByRole('button', { name: /Canvas Field Jacket/ });
  await expect(jacket).toContainText('10 in stock');
  await jacket.click();
  await page.getByRole('button', { name: 'Add one' }).click();
  await page.getByRole('button', { name: 'Checkout' }).click();
  await expect(page.getByLabel('Cash received (£)')).toHaveValue('119.98');
  await page.getByRole('button', { name: 'Confirm payment' }).click();

  const receipt = page.getByRole('dialog');
  const title = receipt.getByRole('heading', { name: /^Order #ORD-/ });
  await expect(title).toBeVisible();
  const orderNumber = (await title.innerText()).replace('Order #', '');
  await expect(receipt.getByText('Paid', { exact: true })).toBeVisible();
  await expect(receipt.locator('dd.total')).toHaveText('£119.98');
  await receipt.getByRole('button', { name: 'Close' }).click();

  async function checkInventory(quantity, status) {
    await page.getByRole('link', { name: /Inventory/ }).click();
    await page.getByLabel('Store location').selectOption('london');
    await page.getByLabel('Search inventory').fill('JKT-001');
    const row = page.getByRole('row').filter({ hasText: 'Canvas Field Jacket' });
    await expect(row.getByRole('cell').nth(2)).toHaveText(quantity);
    await expect(row.getByRole('cell', { name: status, exact: true })).toBeVisible();
  }
  await page.getByRole('button', { name: 'Exit register' }).click();
  await checkInventory('8', 'Low stock');
  await page.getByRole('link', { name: 'Orders', exact: true }).click();
  await page.getByLabel('Search order or customer').fill(orderNumber);
  await page.getByRole('row').filter({ hasText: orderNumber }).click();
  await receipt.getByRole('button', { name: 'Return order' }).click();
  await page.getByLabel('Reason for return').fill('Size exchange');
  await expect(page.getByLabel('Return items to available stock')).toBeChecked();
  await page.getByRole('button', { name: 'Confirm return' }).click();
  await expect(receipt.getByText('Refunded', { exact: true })).toBeVisible();
  await receipt.getByRole('button', { name: 'Close' }).click();
  await page.reload();
  await checkInventory('10', 'In stock');
});

test('a new business can request paid Starter from its Starter trial', async ({ page }) => {
  const email = 'owner@example.test';
  const password = 'Local-browser-test-only';
  await page.goto('/local/signup');
  await page.getByLabel('Your name').fill('Trial Owner');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.getByRole('link', { name: 'Continue to sign in' }).click();
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL(url => url.pathname === '/');
  await page.goto('/?new=1');
  await page.getByLabel('Business name').fill('Test Shop');
  await page.getByLabel('Your name').fill('Trial Owner');
  await page.getByLabel('First store name').fill('London');
  await page.getByRole('button', { name: 'Create workspace', exact: true }).click();
  await expect(page.getByText('Business workspace', { exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Settings' }).click();
  await page.getByRole('button', { name: 'Email delivery' }).click();
  await expect(page.getByRole('dialog')).toContainText('Set RESEND_API_KEY');
  await page.getByRole('button', { name: 'Close',exact:true }).click();
  await page.getByRole('link', { name: 'Billing & plans' }).click();

  const request = page.waitForResponse(res => new URL(res.url()).pathname === '/api/stripe/billing');
  await page.getByRole('button', { name: 'Subscribe to Starter' }).click();
  const response = await request;
  expect(response.request().postDataJSON()).toEqual({ plan: 'Starter' });
  expect(response.status()).toBe(503);
  await expect(page.getByText('This test billing price has not been configured.')).toBeVisible();
  await expect(page.getByText('trial', { exact: true })).toBeVisible();
});

test('sign out ends local access in both register tabs', async ({ page, context, playwright, baseURL }) => {
  const credentials = { email: 'shift@example.test', password: 'Local-shift-test-only' };
  await context.request.post('/local/signup', { form: { ...credentials, name: 'Shift owner' } });
  await context.request.post('/local/signin', { form: credentials });
  await context.request.post('/api/onboard', { data: { name: 'Shift shop', owner: 'Owner', store: 'London' } });
  const other = await context.newPage();
  await Promise.all([page.goto('/'), other.goto('/#pos')]);
  await expect(other.getByRole('heading', { name: 'Point of sale' })).toBeVisible();
  const oldSession = await playwright.request.newContext({ baseURL, storageState: await context.storageState() });
  try {
    await page.getByRole('button', { name: /Shift shop Business workspace/ }).click();
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page).toHaveURL(/\/local\/signin$/);
    await expect(other).toHaveURL(/\/local\/signin$/);
    expect((await (await oldSession.get('/api/identity')).json()).signedIn).toBe(false);
    expect((await oldSession.get('/api/state')).status()).toBe(401);
  } finally {
    await oldSession.dispose();
  }
});
