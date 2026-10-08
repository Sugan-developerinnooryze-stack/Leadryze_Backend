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
    const scopeFilter = {
      tenantId: req.tenantId,
      $or: [{ userId: req.user!.userId }, { userId: { $exists: false } }],
    };
    const [notifications, total] = await Promise.all([
      Notification.find(scopeFilter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit),
      Notification.countDocuments(scopeFilter),
    ]);
    sendPaginated(res, notifications, total, page, limit);
  } catch (err) {
    next(err);
  }
});

/**
 * @swagger
 * /notifications/unread-count:
 *   get:
 *     tags: [Notifications]
 *     summary: Unread notification count for the current user
 */
router.get('/unread-count', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const userId = req.user!.userId;
    const count = await Notification.countDocuments({
      tenantId: req.tenantId,
      $or: [
        { userId, isRead: false },
        { userId: { $exists: false }, readBy: { $ne: userId } },
      ],
    });
    sendSuccess(res, { count });
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
    const userId = req.user!.userId;
    const doc = await Notification.findOne({ _id: req.params.id, tenantId: req.tenantId });
    if (doc) {
      if (doc.userId) {
        await Notification.updateOne({ _id: doc._id }, { isRead: true });
      } else {
        await Notification.updateOne({ _id: doc._id }, { $addToSet: { readBy: userId } });
      }
    }
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
    const userId = req.user!.userId;
    await Promise.all([
      Notification.updateMany({ tenantId: req.tenantId, userId }, { isRead: true }),
      Notification.updateMany(
        { tenantId: req.tenantId, userId: { $exists: false } },
        { $addToSet: { readBy: userId } },
      ),
    ]);
    sendSuccess(res, null, 'All notifications marked as read');
  } catch (err) {
    next(err);
  }
});

export default router;
