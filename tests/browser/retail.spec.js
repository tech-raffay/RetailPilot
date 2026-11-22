import { test, expect } from '@playwright/test';

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
  await page.goto('/#pos');
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
