import { test, expect } from '@playwright/test';

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
  await page.getByRole('link', { name: 'Billing & plans' }).click();

  const request = page.waitForResponse(res => new URL(res.url()).pathname === '/api/stripe/billing');
  await page.getByRole('button', { name: 'Subscribe to Starter' }).click();
  const response = await request;
  expect(response.request().postDataJSON()).toEqual({ plan: 'Starter' });
  expect(response.status()).toBe(503);
  await expect(page.getByText('This test billing price has not been configured.')).toBeVisible();
  await expect(page.getByText('trial', { exact: true })).toBeVisible();
});
