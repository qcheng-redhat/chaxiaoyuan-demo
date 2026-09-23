/*
 * Core ordering flow — the two highest-value cases from the test plan,
 * plus delivery validation, persistence and the double-click guard.
 */
'use strict';

var test = require('@playwright/test').test;
var expect = require('@playwright/test').expect;
var h = require('./helpers');

test.describe('下单主流程', function () {

  test('立即点单 → 选规格 → 加入 → 提交，全程金额正确', async function ({ page }) {
    await page.goto('/');

    // 1. hero button scrolls to the star products section
    await page.click('#heroOrder');
    await expect(page.locator('#stars')).toBeInViewport();

    // 2. open spec sheet for 黑糖珍珠鲜奶 (p1, base ¥16), default 少冰/半糖
    await page.click('.add-btn[data-id="p1"]');
    await expect(page.locator('#sheet')).toHaveClass(/on/);
    await expect(page.locator('#sName')).toHaveText('黑糖珍珠鲜奶');
    await expect(page.locator('#sSum')).toHaveText('¥16');

    // 3. add one topping -> subtotal becomes 16 + 3
    await page.click('#sAddon .chip[data-v="珍珠"]');
    await expect(page.locator('#sSum')).toHaveText('¥19');

    // 4. confirm -> cart drawer opens with the spec text and correct total
    await page.click('#sOk');
    await expect(page.locator('#drawer')).toHaveClass(/on/);
    await expect(page.locator('#cartBody .ci')).toHaveCount(1);
    await expect(page.locator('#cartBody .ci .nm')).toHaveText('黑糖珍珠鲜奶');
    await expect(page.locator('#cartBody .ci .sp')).toContainText('珍珠');
    await expect(page.locator('#totalPrice')).toHaveText('¥19');
    await expect(page.locator('#totalQty')).toHaveText('1');
    await expect(page.locator('#navCount')).toHaveText('1');

    // 5. submit -> success dialog with a well-formed order number
    await page.click('#submitBtn');
    await expect(page.locator('#done')).toHaveClass(/on/);
    await expect(page.locator('#doneNo')).toContainText(/CY\d{10}-\d{4}/);
  });

  test('同一饮品不同规格拆成两行（specKey 逻辑）', async function ({ page }) {
    await page.goto('/');

    // first: default spec (少冰/半糖)
    await h.addProduct(page, 'p1');
    await h.closeCart(page);

    // second: explicitly different spec -> must be a separate cart line
    await page.click('.add-btn[data-id="p1"]');
    await page.waitForSelector('#sheet.on');
    await page.click('#sIce .chip[data-v="热饮"]');
    await page.click('#sSugar .chip[data-v="无糖"]');
    await page.click('#sOk');
    await page.waitForFunction(function () {
      return !document.querySelector('#sheet').classList.contains('on');
    });

    await expect(page.locator('#cartBody .ci')).toHaveCount(2);
    await expect(page.locator('#totalQty')).toHaveText('2');
    await expect(page.locator('#totalPrice')).toHaveText('¥32');
    await expect(page.locator('#cartBody .ci .sp').nth(1)).toContainText('热饮');
    await expect(page.locator('#cartBody .ci .sp').nth(1)).toContainText('无糖');
  });

  test('选外送不填手机号 → 拦截并提示，不出单', async function ({ page }) {
    await page.goto('/');
    await h.addProduct(page, 'p2');
    await page.click('#pickRow [data-pick="需要外送"]');

    await page.click('#submitBtn');
    await expect(page.locator('#done')).not.toHaveClass(/on/);
    await expect(page.locator('#toast')).toContainText('手机号');

    // fill the phone -> now it goes through
    await page.fill('#phone', '13800000000');
    await page.click('#submitBtn');
    await expect(page.locator('#done')).toHaveClass(/on/);
  });

  test('加购后刷新页面，购物车保留（localStorage 持久化）', async function ({ page }) {
    await page.goto('/');
    await h.addProduct(page, 'p3');
    await h.closeCart(page);
    await expect(page.locator('#navCount')).toHaveText('1');

    await page.reload();
    await expect(page.locator('#navCount')).toHaveText('1');
    await h.openCart(page);
    await expect(page.locator('#cartBody .ci .nm')).toHaveText('芋泥波波奶茶');
  });

  test('双击防护：同步触发两次提交只发一次请求', async function ({ page }) {
    await page.goto('/');
    await h.addProduct(page, 'p4');

    var posts = 0;
    page.on('request', function (r) {
      if (r.url().indexOf('/api/orders') > -1 && r.method() === 'POST') posts++;
    });

    // two synchronous clicks in the same tick — the guard must swallow the 2nd
    await page.evaluate(function () {
      var b = document.querySelector('#submitBtn');
      b.click(); b.click();
    });
    await expect(page.locator('#done')).toHaveClass(/on/);
    await page.waitForTimeout(500);
    expect(posts).toBe(1);
  });
});

test.describe('下单成功弹窗', function () {

  test('「完成」按钮：关闭弹窗和购物车抽屉，回到干净菜单页', async function ({ page }) {
    await page.goto('/');
    await h.addProduct(page, 'p1');
    await page.waitForSelector('#drawer.on');
    await h.submitOrder(page);

    await expect(page.locator('#doneBtn')).toBeVisible();
    await expect(page.locator('#doneBtn')).toHaveText('完成');
    await page.click('#doneBtn');

    await expect(page.locator('#done')).not.toHaveClass(/on/);
    await expect(page.locator('#drawer')).not.toHaveClass(/on/);
    await expect(page.locator('#mask')).not.toHaveClass(/on/);
  });

  test('矮视口（375×500，横屏/内嵌浏览器）：完成按钮不出屏且可点', async function ({ browser }) {
    var c = await browser.newContext({ viewport: { width: 375, height: 500 } });
    var p = await c.newPage();
    await p.goto('/');
    await h.addProduct(p, 'p1');
    await p.waitForSelector('#drawer.on');
    await h.submitOrder(p);

    // the whole button must sit inside the viewport — previously the fixed-height
    // dialog could push it below the fold with the backdrop blocking any scroll
    var box = await p.locator('#doneBtn').boundingBox();
    expect(box).toBeTruthy();
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.y + box.height).toBeLessThanOrEqual(500);
    await p.click('#doneBtn');
    await expect(p.locator('#done')).not.toHaveClass(/on/);
    await c.close();
  });

  test('英文页同样有 Done 按钮', async function ({ page }) {
    await page.goto('/index-en.html');
    await h.addProduct(page, 'p1');
    await page.waitForSelector('#drawer.on');
    await h.submitOrder(page);

    await expect(page.locator('#doneBtn')).toHaveText('Done');
    await page.click('#doneBtn');
    await expect(page.locator('#done')).not.toHaveClass(/on/);
  });
});
