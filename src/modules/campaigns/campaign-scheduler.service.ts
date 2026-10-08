import { Campaign } from './campaign.model';
import { dispatchCampaignTick } from './campaign-dispatch.service';
import { logger } from '../../utils/logger';

// Promotes due 'scheduled' campaigns to 'running' and kicks their first
// dispatch tick. Runs regardless of Redis/BullMQ availability — this is the
// entire point of this design (see the plan's Context section).
export async function runCampaignSchedulePromotion(): Promise<void> {
  const due = await Campaign.find({ status: 'scheduled', 'schedule.startAt': { $lte: new Date() } }).select('_id');
  for (const campaign of due) {
    // Atomic, status-guarded promotion — if two overlapping ticks both see
    // this campaign as 'scheduled', only one of them actually flips it, so
    // dispatchCampaignTick is only kicked once per campaign per promotion.
    const claimed = await Campaign.findOneAndUpdate(
      { _id: campaign._id, status: 'scheduled' },
      { $set: { status: 'running' } },
      { new: true }
    );
    if (claimed) {
      void dispatchCampaignTick(String(claimed._id)).catch((err) =>
        logger.error('dispatchCampaignTick crashed after schedule promotion', { campaignId: claimed._id, error: (err as Error).message })
      );
    }
  }
}

// Restart/safety-net sweep — guarantees forward progress for every 'running'
// campaign regardless of whether the fire-and-forget tick inside
// activateCampaign()/resumeCampaign() ever completed (e.g. the process
// restarted mid-send).
export async function runCampaignDispatchTicks(): Promise<void> {
  const running = await Campaign.find({ status: 'running' }).select('_id');
  for (const campaign of running) {
    await dispatchCampaignTick(String(campaign._id)).catch((err) =>
      logger.error('dispatchCampaignTick crashed', { campaignId: campaign._id, error: (err as Error).message })
    );
  }
}
