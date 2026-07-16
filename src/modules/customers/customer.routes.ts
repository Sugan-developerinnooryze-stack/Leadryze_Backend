import { Router } from 'express';
import * as controller from './customer.controller';
import { authenticate, requirePermission } from '../../middlewares/auth.middleware';
import { requireTenant } from '../../middlewares/tenant.middleware';

const router = Router();

/**
 * @swagger
 * tags:
 *   name: Customers
 *   description: Lead and customer management
 */

router.use(authenticate, requireTenant);

/**
 * @swagger
 * /customers/stats:
 *   get:
 *     tags: [Customers]
 *     summary: Get customer statistics for tenant
 *     responses:
 *       200: { description: Stats object }
 */
router.get('/stats', requirePermission('customers.view'), controller.getCustomerStats);

/**
 * @swagger
 * /customers:
 *   get:
 *     tags: [Customers]
 *     summary: List all customers (paginated)
 *     parameters:
 *       - in: query
 *         name: status
 *         schema: { type: string, enum: [new, contacted, qualified, booked, lost] }
 *       - in: query
 *         name: channel
 *         schema: { type: string }
 *       - in: query
 *         name: search
 *         schema: { type: string }
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 20 }
 *     responses:
 *       200: { description: Paginated customer list }
 *   post:
 *     tags: [Customers]
 *     summary: Create a new customer/lead
 *     responses:
 *       201: { description: Customer created }
 */
router.get('/', requirePermission('customers.view'), controller.getCustomers);
router.post('/', requirePermission('customers.create'), controller.createCustomer);

/**
 * @swagger
 * /customers/{id}:
 *   get:
 *     tags: [Customers]
 *     summary: Get a customer by ID
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Customer object }
 *       404: { description: Not found }
 *   put:
 *     tags: [Customers]
 *     summary: Update a customer
 *     responses:
 *       200: { description: Updated customer }
 *   delete:
 *     tags: [Customers]
 *     summary: Delete a customer
 *     responses:
 *       200: { description: Deleted }
 */
router.get('/:id', requirePermission('customers.view'), controller.getCustomer);
router.put('/:id', requirePermission('customers.edit'), controller.updateCustomer);
router.delete('/:id', requirePermission('customers.delete'), controller.deleteCustomer);

export default router;
