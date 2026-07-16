import { Response, NextFunction } from 'express';
import { AuthRequest } from '../../types';
import * as campaignService from './campaign.service';
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
  } catch (err) { next(err); }
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
