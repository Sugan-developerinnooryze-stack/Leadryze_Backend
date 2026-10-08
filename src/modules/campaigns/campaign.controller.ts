import { Response, NextFunction } from 'express';
import { AuthRequest } from '../../types';
import * as campaignService from './campaign.service';
import { CampaignEditLockedError } from './campaign.service';
import * as lifecycle from './campaign-lifecycle.service';
import { CampaignActionError } from './campaign-lifecycle.service';
import { previewAudience } from './campaign-dispatch.service';
import { CampaignRecipient } from './campaign-recipient.model';
import { Campaign } from './campaign.model';
import { sendSuccess, sendCreated, sendError, sendPaginated } from '../../utils/response';
import { writeLog } from '../logs/log.service';

function actor(req: AuthRequest) {
  return {
    userId:    req.user?.userId,
    userEmail: req.user?.email,
    userRole:  req.user?.role,
  };
}

export async function createCampaign(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const campaign = await campaignService.createCampaign(req.tenantId!, req.user!.userId, req.body);
    sendCreated(res, campaign, 'Campaign created');
    writeLog({
      tenantId: req.tenantId!,
      service:  'backend',
      level:    'info',
      event:    'campaign.created',
      message:  `Campaign "${campaign.name}" (${campaign.type}) created`,
      metadata: {
        campaignId:   String(campaign._id),
        campaignName: campaign.name,
        campaignType: campaign.type,
        status:       campaign.status,
        ...actor(req),
      },
    });
  } catch (err) { next(err); }
}

export async function getCampaigns(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const { campaigns, total, page, limit } = await campaignService.getCampaigns(req.tenantId!, req.query as Record<string, unknown>);
    sendPaginated(res, campaigns, total, page, limit);
  } catch (err) { next(err); }
}

export async function getCampaign(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const campaign = await campaignService.getCampaignById(req.tenantId!, req.params.id);
    if (!campaign) { sendError(res, 'Campaign not found', 404); return; }
    sendSuccess(res, campaign);
  } catch (err) { next(err); }
}

export async function updateCampaign(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const campaign = await campaignService.updateCampaign(req.tenantId!, req.params.id, req.body);
    if (!campaign) { sendError(res, 'Campaign not found', 404); return; }
    sendSuccess(res, campaign, 'Campaign updated');
    writeLog({
      tenantId: req.tenantId!,
      service:  'backend',
      level:    'info',
      event:    'campaign.updated',
      message:  `Campaign "${campaign.name}" updated`,
      metadata: {
        campaignId:    String(campaign._id),
        campaignName:  campaign.name,
        campaignType:  campaign.type,
        status:        campaign.status,
        changedFields: Object.keys(req.body),
        ...actor(req),
      },
    });
  } catch (err) {
    if (err instanceof CampaignEditLockedError) { sendError(res, err.message, 400); return; }
    next(err);
  }
}

export async function deleteCampaign(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    await campaignService.deleteCampaign(req.tenantId!, req.params.id);
    sendSuccess(res, null, 'Campaign deleted');
    writeLog({
      tenantId: req.tenantId!,
      service:  'backend',
      level:    'warn',
      event:    'campaign.deleted',
      message:  `Campaign ${req.params.id} deleted`,
      metadata: {
        campaignId: req.params.id,
        ...actor(req),
      },
    });
  } catch (err) { next(err); }
}

function handleLifecycleError(err: unknown, res: Response, next: NextFunction): void {
  if (err instanceof CampaignActionError) { sendError(res, err.message, err.status); return; }
  next(err);
}

export async function activateCampaign(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const campaign = await lifecycle.activateCampaign(req.tenantId!, req.params.id);
    sendSuccess(res, campaign, 'Campaign activated');
    writeLog({
      tenantId: req.tenantId!, service: 'backend', level: 'info', event: 'campaign.activated',
      message: `Campaign "${campaign.name}" activated`,
      metadata: { campaignId: String(campaign._id), status: campaign.status, ...actor(req) },
    });
  } catch (err) { handleLifecycleError(err, res, next); }
}

export async function pauseCampaign(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const campaign = await lifecycle.pauseCampaign(req.tenantId!, req.params.id);
    sendSuccess(res, campaign, 'Campaign paused');
  } catch (err) { handleLifecycleError(err, res, next); }
}

export async function resumeCampaign(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const campaign = await lifecycle.resumeCampaign(req.tenantId!, req.params.id);
    sendSuccess(res, campaign, 'Campaign resumed');
  } catch (err) { handleLifecycleError(err, res, next); }
}

export async function cancelCampaign(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const campaign = await lifecycle.cancelCampaign(req.tenantId!, req.params.id);
    sendSuccess(res, campaign, 'Campaign cancelled');
  } catch (err) { handleLifecycleError(err, res, next); }
}

export async function duplicateCampaign(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const campaign = await lifecycle.duplicateCampaign(req.tenantId!, req.user!.userId, req.params.id);
    sendCreated(res, campaign, 'Campaign duplicated');
  } catch (err) { handleLifecycleError(err, res, next); }
}

export async function testSendCampaign(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const result = await lifecycle.testSendCampaign(req.tenantId!, req.params.id, req.body.to);
    sendSuccess(res, result, result.sent ? 'Test message sent' : 'Test message could not be sent — check channel configuration');
  } catch (err) { handleLifecycleError(err, res, next); }
}

export async function audiencePreview(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const campaign = await Campaign.findOne({ _id: req.params.id, tenantId: req.tenantId! });
    if (!campaign) { sendError(res, 'Campaign not found', 404); return; }
    const preview = await previewAudience(req.tenantId!, campaign.audience, campaign.channel as 'email' | 'whatsapp' | 'sms');
    sendSuccess(res, preview);
  } catch (err) { next(err); }
}

export async function getCampaignRecipients(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Number(req.query.limit) || 50);
    const filter: Record<string, unknown> = { campaignId: req.params.id, tenantId: req.tenantId! };
    if (req.query.status) filter.status = req.query.status;
    const [recipients, total] = await Promise.all([
      CampaignRecipient.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit),
      CampaignRecipient.countDocuments(filter),
    ]);
    sendPaginated(res, recipients, total, page, limit);
  } catch (err) { next(err); }
}
