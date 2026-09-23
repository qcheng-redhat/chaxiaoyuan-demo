/*
 * Tea Courtyard — E2E test helpers.
 * Shared helpers to open the page and drive the spec modal / cart drawer.
 */
'use strict';

var ORDER_NO_RE = /订单号\s*CY\d{10}-\d{4}|Order No\.?\s*CY\d{10}-\d{4}/;

/* Open the spec sheet for a product and confirm with the chosen options.
 * ice/sugar are the visible Chinese labels; addons is an array of labels. */
async function addProduct(page, productId, opts) {
  opts = opts || {};
  await page.click('.add-btn[data-id="' + productId + '"]');
  await page.waitForSelector('#sheet.on');

  if (opts.ice) await page.click('#sIce .chip[data-v="' + opts.ice + '"]');
  if (opts.sugar) await page.click('#sSugar .chip[data-v="' + opts.sugar + '"]');
  if (opts.addons) {
    for (var i = 0; i < opts.addons.length; i++) {
      await page.click('#sAddon .chip[data-v="' + opts.addons[i] + '"]');
    }
  }
  await page.click('#sOk');
  await page.waitForSelector('#sheet.on', { state: 'detached' }).catch(function () {});
  await page.waitForFunction(function () {
    return !document.querySelector('#sheet').classList.contains('on');
  });
}

async function openCart(page) {
  await page.click('#navCart');
  await page.waitForSelector('#drawer.on');
}

async function closeCart(page) {
  await page.click('#drawerClose');
  await page.waitForFunction(function () {
    return !document.querySelector('#drawer').classList.contains('on');
  });
}

async function submitOrder(page) {
  await page.click('#submitBtn');
  await page.waitForSelector('#done.on');
}

module.exports = { ORDER_NO_RE, addProduct, openCart, closeCart, submitOrder };
