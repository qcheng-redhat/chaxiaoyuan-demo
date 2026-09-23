/*
 * Store dashboard session tests.
 *
 * Context: the dashboard keeps its token in sessionStorage and, as a backup transport,
 * in a cookie (the publishing gateway rewrites the Authorization header, so a second
 * channel is needed). That cookie used to carry max-age=604800, which turned the login
 * gate into "remember me for a week" — anyone opening the page on that machine walked
 * straight in, with no way to end the session. These tests pin the fixed behaviour.
 */
'use strict';

var test = require('@playwright/test').test;
var expect = require('@playwright/test').expect;

var PWD = 'test-pass-123';

async function cyCookie(context) {
  var all = await context.cookies();
  return all.filter(function (c) { return c.name === 'cy_token'; })[0] || null;
}

test.describe('订单后台 · 登录会话', function () {

  test('全新会话打开后台：必须要求输入口令，且不能把登录框点掉', async function ({ page }, testInfo) {
    test.skip(testInfo.project.name === 'mobile', 'desktop-only scenario');

    await page.goto('/orders.html');
    await expect(page.locator('#login')).toBeVisible();
    /* an empty dashboard behind a dismissible prompt is still a leak — the prompt is a
     * gate, so clicking the backdrop must not reveal the page */
    await page.click('#loginMask', { position: { x: 12, y: 12 } });
    await expect(page.locator('#login')).toBeVisible();
    await expect(page.locator('#loginMask')).toHaveClass(/on/);
  });

  test('登录后 cookie 是会话级的（关浏览器即失效，不是 7 天）', async function ({ page }, testInfo) {
    test.skip(testInfo.project.name === 'mobile', 'desktop-only scenario');

    await page.goto('/orders.html');
    await page.fill('#loginPwd', PWD);
    await page.click('#loginOk');
    await expect(page.locator('#login')).not.toBeVisible({ timeout: 15000 });

    var cookie = await cyCookie(page.context());
    expect(cookie, 'token cookie must exist as a backup channel').toBeTruthy();
    expect(cookie.expires, 'session cookie must have expires = -1').toBe(-1);
  });

  test('退出登录：清掉两处凭据，刷新后仍要求口令', async function ({ page }, testInfo) {
    test.skip(testInfo.project.name === 'mobile', 'desktop-only scenario');

    await page.goto('/orders.html');
    await page.fill('#loginPwd', PWD);
    await page.click('#loginOk');
    await expect(page.locator('#login')).not.toBeVisible({ timeout: 15000 });
    /* the sign-out control only exists while signed in */
    await expect(page.locator('#logoutBtn')).toBeVisible();

    await page.click('#logoutBtn');
    await expect(page.locator('#login')).toBeVisible();
    expect(await cyCookie(page.context()), 'cookie must be gone after signing out').toBe(null);
    expect(await page.evaluate(function () { return sessionStorage.getItem('cy_token'); })).toBe(null);
    await expect(page.locator('#logoutBtn')).not.toBeVisible();

    /* a reload must not let the page back in through any leftover channel */
    await page.reload();
    await expect(page.locator('#login')).toBeVisible();
    await expect(page.locator('#login')).toHaveClass(/on/);
  });

  test('英文后台同样有退出登录入口', async function ({ page }, testInfo) {
    test.skip(testInfo.project.name === 'mobile', 'desktop-only scenario');

    await page.goto('/orders-en.html');
    await page.fill('#loginPwd', PWD);
    await page.click('#loginOk');
    await expect(page.locator('#login')).not.toBeVisible({ timeout: 15000 });
    await expect(page.locator('#logoutBtn')).toBeVisible();
    await page.click('#logoutBtn');
    await expect(page.locator('#login')).toBeVisible();
    expect(await cyCookie(page.context())).toBe(null);
  });
});
