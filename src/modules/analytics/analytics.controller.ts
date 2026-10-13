import { Response, NextFunction } from 'express';
import { AuthRequest } from '../../types';
import * as analyticsService from './analytics.service';
import { generateAnalyticsWorkbook, generateAnalyticsCsv } from './analytics.export.service';
import { sendSuccess } from '../../utils/response';

function extractFilters(req: AuthRequest) {
  const { preset, startDate, endDate, branchId, timezone, referenceDate } = req.query as Record<string, string>;
  const effectiveBranchId = branchId || req.branchId || undefined;
  const dateFilter: analyticsService.DateRangeFilter = {
    preset,
    startDate,
    endDate,
    timezone,
    referenceDate,
  };
  return { effectiveBranchId, dateFilter };
}

export async function getDashboard(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const { effectiveBranchId, dateFilter } = extractFilters(req);
    const stats = await analyticsService.getDashboardStats(req.tenantId!, effectiveBranchId, dateFilter);
    sendSuccess(res, stats, 'Dashboard stats fetched');
  } catch (err) {
    next(err);
  }
}

export async function getLeadsSales(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const { effectiveBranchId, dateFilter } = extractFilters(req);
    const data = await analyticsService.getLeadsAndSalesAnalytics(req.tenantId!, effectiveBranchId, dateFilter);
    sendSuccess(res, data, 'Lead and sales analytics fetched');
  } catch (err) {
    next(err);
  }
}

export async function getCrm(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const { effectiveBranchId, dateFilter } = extractFilters(req);
    const data = await analyticsService.getCrmAnalytics(req.tenantId!, effectiveBranchId, dateFilter);
    sendSuccess(res, data, 'CRM analytics fetched');
  } catch (err) {
    next(err);
  }
}

export async function getSupport(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const { effectiveBranchId, dateFilter } = extractFilters(req);
    const data = await analyticsService.getSupportAnalytics(req.tenantId!, effectiveBranchId, dateFilter);
    sendSuccess(res, data, 'Support analytics fetched');
  } catch (err) {
    next(err);
  }
}

export async function getFieldService(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const { effectiveBranchId, dateFilter } = extractFilters(req);
    const data = await analyticsService.getFieldServiceAnalytics(req.tenantId!, effectiveBranchId, dateFilter);
    sendSuccess(res, data, 'Field service analytics fetched');
  } catch (err) {
    next(err);
  }
}

export async function getAutomation(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const { effectiveBranchId, dateFilter } = extractFilters(req);
    const data = await analyticsService.getAutomationAnalytics(req.tenantId!, effectiveBranchId, dateFilter);
    sendSuccess(res, data, 'Automation analytics fetched');
  } catch (err) {
    next(err);
  }
}

export async function exportAnalytics(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const { effectiveBranchId, dateFilter } = extractFilters(req);
    const format = ((req.query.format as string) || 'xlsx').toLowerCase();
    const section = (req.query.section as string) || 'overview';
    const preset = dateFilter.preset || 'period';

    if (format === 'csv') {
      const csvResult = await generateAnalyticsCsv(
        req.tenantId!,
        effectiveBranchId,
        section,
        dateFilter,
        req.user?.email
      );
      res.setHeader('Content-Type', csvResult.contentType);
      res.setHeader('Content-Disposition', `attachment; filename=${csvResult.filename}`);
      res.status(200).send(csvResult.buffer);
      return;
    }

    // Default: Multi-worksheet Enterprise Excel Workbook
    const buffer = await generateAnalyticsWorkbook(
      req.tenantId!,
      effectiveBranchId,
      dateFilter,
      req.user?.email
    );

    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
    res.setHeader(
      'Content-Disposition',
      `attachment; filename=LeadRyze_AI_Analytics_Report_${preset}_${Date.now()}.xlsx`
    );
    res.status(200).send(buffer);
  } catch (err) {
    next(err);
  }
}

export async function getAnalytics(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const { startDate, endDate, channel } = req.query as Record<string, string>;
    const start = startDate || new Date(Date.now() - 30 * 86400000).toISOString();
    const end = endDate || new Date().toISOString();
    const data = await analyticsService.getAnalyticsByRange(req.tenantId!, start, end, channel);
    sendSuccess(res, data);
  } catch (err) {
    next(err);
  }
}
