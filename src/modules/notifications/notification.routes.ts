import { Router, Response, NextFunction } from 'express';
import { authenticate } from '../../middlewares/auth.middleware';
import { requireTenant } from '../../middlewares/tenant.middleware';
import { AuthRequest } from '../../types';
import { Notification } from './notification.model';
import { sendSuccess, sendPaginated } from '../../utils/response';

const router = Router();

/**
 * @swagger
 * tags:
 *   name: Notifications
 *   description: In-app notifications
 */

router.use(authenticate, requireTenant);

/**
 * @swagger
 * /notifications:
 *   get:
 *     tags: [Notifications]
 *     summary: List notifications for current user
 */
router.get('/', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const page = parseInt(String(req.query.page || '1'));
    const limit = 20;
    const skip = (page - 1) * limit;
    const [notifications, total] = await Promise.all([
      Notification.find({
        tenantId: req.tenantId,
        $or: [{ userId: req.user!.userId }, { userId: { $exists: false } }],
      })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit),
      Notification.countDocuments({ tenantId: req.tenantId }),
    ]);
    sendPaginated(res, notifications, total, page, limit);
  } catch (err) {
    next(err);
  }
});

/**
 * @swagger
 * /notifications/{id}/read:
 *   patch:
 *     tags: [Notifications]
 *     summary: Mark a notification as read
 */
router.patch('/:id/read', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    await Notification.findOneAndUpdate(
      { _id: req.params.id, tenantId: req.tenantId },
      { isRead: true }
    );
    sendSuccess(res, null, 'Notification marked as read');
  } catch (err) {
    next(err);
  }
});

/**
 * @swagger
 * /notifications/read-all:
 *   patch:
 *     tags: [Notifications]
 *     summary: Mark all notifications as read
 */
router.patch('/read-all', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    await Notification.updateMany({ tenantId: req.tenantId }, { isRead: true });
    sendSuccess(res, null, 'All notifications marked as read');
  } catch (err) {
    next(err);
  }
});

export default router;
