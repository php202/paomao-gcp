/**
 * lib/giveme.js — 統一 Giveme 電子發票 API 模組（ESM）
 *
 * 重新 export core-api.js 的 issueInvoice + getOdooInvoice
 * 供各模組統一 import { issueInvoice } from '../lib/giveme.js'
 */

export { issueInvoice, getOdooInvoice } from '../api/core-api.js';
