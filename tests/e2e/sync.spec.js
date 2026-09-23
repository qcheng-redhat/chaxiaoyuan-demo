/*
 * Two-page sync: customer places an order on the menu page,
 * the store dashboard (orders.html) shows it after login.
 * Runs only on the desktop project.
 */
'use strict';

var test = require('@playwright/test').test;
var expect = require('@playwright/test').expect;
var h = require('./helpers');

test.skip(({ browserName }) => false); // keep default; per-project skip below

test.describe('菜单页 → 订单后台 跨页同步', function () {

  test('顾客下单后，店家后台登录即可看到该订单', async function ({ page }, testInfo) {
    test.skip(testInfo.project.name === 'mobile', 'desktop-only scenario');

    // customer places an order
    await page.goto('/');
    await h.addProduct(page, 'p1', { addons: ['布丁'] });
    await h.submitOrder(page);
    var noText = await page.locator('#doneNo').textContent();
    var orderNo = (noText.match(/CY\d{10}-\d{4}/) || [])[0];
    expect(orderNo).toBeTruthy();

    // close the success dialog so the page is idle
    await page.keyboard.press('Escape');

    // store opens the dashboard and logs in with the test password
    await page.goto('/orders.html');
    await expect(page.locator('#login')).toBeVisible();
    await page.fill('#loginPwd', 'test-pass-123');
    await page.click('#loginOk');

    // the order card appears with the same order number and its item
    await expect(page.locator('#list')).toContainText(orderNo, { timeout: 15000 });
    await expect(page.locator('#list')).toContainText('黑糖珍珠鲜奶');
    await expect(page.locator('#list')).toContainText('布丁');

    // metrics reflect it: today's order count >= 1
    await expect(page.locator('#mOrders')).not.toHaveText(/^0/);
  });

  test('错误口令被拒绝', async function ({ page }, testInfo) {
    test.skip(testInfo.project.name === 'mobile', 'desktop-only scenario');

    await page.goto('/orders.html');
    await page.fill('#loginPwd', 'totally-wrong');
    await page.click('#loginOk');
    await expect(page.locator('#loginErr')).toContainText(/口令|密码|错误|wrong/i);
    await expect(page.locator('#login')).toBeVisible();
  });

  /* Regression test for the live outage: the reverse proxy stripped the
   * Authorization header, so a valid token was rejected with 401 and the
   * dashboard bounced back to the login box. The token must also travel
   * via query/cookie so auth still works. */
  test('代理剥掉 Authorization 头时，登录依然成功（token 走 query/cookie）', async function ({ page }, testInfo) {
    test.skip(testInfo.project.name === 'mobile', 'desktop-only scenario');

    await page.route('**/api/**', function (route) {
      var headers = Object.assign({}, route.request().headers());
      delete headers['authorization'];
      route.continue({ headers: headers });
    });

    await page.goto('/orders.html');
    await expect(page.locator('#login')).toBeVisible();
    await page.fill('#loginPwd', 'test-pass-123');
    await page.click('#loginOk');

    // dashboard opens: login box goes away and the list area renders
    await expect(page.locator('#login')).not.toBeVisible({ timeout: 10000 });
    await expect(page.locator('#mOrders')).toBeVisible();
  });
});
