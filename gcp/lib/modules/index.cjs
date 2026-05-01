/**
 * 📦 發票模組索引
 * 統一導出所有發票相關模組
 */

// 核心模組
const { UnifiedInvoiceService, getUnifiedInvoiceService, issueInvoice } = require('../unified-invoice.cjs');

// 子模組
const { InvoiceValidator } = require('./invoice-validator.cjs');
const { GiveMeClient } = require('./giveme-client.cjs');
const { InvoiceLogger } = require('./invoice-logger.cjs');
const { DashboardAdapter } = require('./dashboard-adapter.cjs');

module.exports = {
  // 🎯 主要服務
  UnifiedInvoiceService,
  getUnifiedInvoiceService,
  issueInvoice,
  
  // 🧩 子模組
  InvoiceValidator,
  GiveMeClient,
  InvoiceLogger,
  DashboardAdapter,
  
  // 📋 便利別名
  Validator: InvoiceValidator,
  Client: GiveMeClient,
  Logger: InvoiceLogger,
  Adapter: DashboardAdapter
};