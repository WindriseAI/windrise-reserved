import { aliyunKey } from './credentials.mjs';
import { rpc } from './http.mjs';
import { freshValue, number, DAY } from './model.mjs';

export async function collectBalance(key, fetchImpl, now) {
  aliyunKey(key);
  const body = await rpc(fetchImpl, 'business.aliyuncs.com', 'QueryAccountBalance', '2017-12-14', key, {}, now);
  if (body.Success !== true || !body.Data || !['CNY', 'USD', 'JPY'].includes(body.Data.Currency)) throw new Error('empty_response');
  const extra = { unit: body.Data.Currency };
  return { values: {
    'aliyun.available': freshValue(number(body.Data.AvailableAmount, { signed: true }), now, extra),
    'aliyun.cash': freshValue(number(body.Data.AvailableCashAmount, { signed: true }), now, { unit: body.Data.Currency }),
  }, issues: {} };
}

export async function collectYesterdayBill(key, fetchImpl, now) {
  aliyunKey(key);
  const yesterday = new Date(now + 8 * 3_600_000 - DAY).toISOString().slice(0, 10);
  let total = 0; let received = 0; let expected; let currency;
  for (let page = 1; page <= 100; page++) {
    const body = await rpc(fetchImpl, 'business.aliyuncs.com', 'QueryAccountBill', '2017-12-14', key,
      { BillingCycle: yesterday.slice(0, 7), Granularity: 'DAILY', BillingDate: yesterday, PageNum: page, PageSize: 300 }, now);
    const data = body.Data;
    const items = data?.Items?.Item;
    if (body.Success !== true || !Array.isArray(items) || items.length === 0) throw new Error('empty_response');
    const count = number(data.TotalCount);
    if (expected !== undefined && count !== expected) throw new Error('changed_pagination');
    expected = count;
    for (const item of items) {
      if (!['CNY', 'USD', 'JPY'].includes(item.Currency) || (currency && currency !== item.Currency)) throw new Error('mixed_currency');
      currency = item.Currency;
      total += number(item.PretaxAmount, { signed: true });
    }
    received += items.length;
    if (received === expected) return { values: { 'aliyun.yesterday_bill': freshValue(total, now, { unit: currency, billingDate: yesterday }) }, issues: {} };
    if (received > expected || items.length < 300) throw new Error('incomplete_pagination');
  }
  throw new Error('truncated_response');
}
