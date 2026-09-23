/*
 * Mobile smoke test — runs ONLY on the "mobile" project (390x844, touch).
 * Abbreviated version of the main flow to make sure the layout holds up.
 */
'use strict';

var test = require('@playwright/test').test;
var expect = require('@playwright/test').expect;
var h = require('./helpers');

test.describe('移动端冒烟', function () {

  test('手机视口：主流程走通，弹层不溢出', async function ({ page }, testInfo) {
    test.skip(testInfo.project.name !== 'mobile', 'mobile-only scenario');

    await page.goto('/');

    // hero button visible and leads to products
    await page.click('#heroOrder');
    await expect(page.locator('#stars')).toBeInViewport();

    // add a drink through the spec sheet
    await page.click('.add-btn[data-id="p1"]');
    await expect(page.locator('#sheet')).toHaveClass(/on/);
    await expect(page.locator('#sSum')).toHaveText('¥16');
    await page.click('#sOk');

    // drawer fits inside the viewport (wait for the slide-in transition first)
    await expect(page.locator('#drawer')).toHaveClass(/on/);
    await page.waitForTimeout(500); // let transform transition finish
    var drawerBox = await page.locator('#drawer').boundingBox();
    expect(drawerBox.x).toBeGreaterThanOrEqual(0);
    expect(drawerBox.x + drawerBox.width).toBeLessThanOrEqual(390);

    // complete the order
    await page.click('#submitBtn');
    await expect(page.locator('#done')).toHaveClass(/on/);
    await expect(page.locator('#doneNo')).toContainText(/CY\d{10}-\d{4}/);
  });

  test('手机视口：菜单行可点，能唤起规格面板', async function ({ page }, testInfo) {
    test.skip(testInfo.project.name !== 'mobile', 'mobile-only scenario');

    await page.goto('/');
    await page.locator('.menu-row[data-id="m6"]').click();
    await expect(page.locator('#sheet')).toHaveClass(/on/);
    await expect(page.locator('#sName')).toHaveText('四季春柠檬茶');

    // hot + no sugar fits the lemon-tea vibe
    await page.click('#sIce .chip[data-v="去冰"]');
    await page.click('#sSugar .chip[data-v="无糖"]');
    await page.click('#sOk');
    await expect(page.locator('#navCount')).toHaveText('1');
  });
});
