import { Response } from 'express';
import { AuthRequest } from '../../../types';
import { sendSuccess, sendError } from '../../../utils/response';
import { CustomTemplate, TemplateDocType } from './custom-template.model';
import { NativeCustomField } from '../custom-fields/custom-field.model';
import { buildCatalogForDocType, MODULE_FOR_DOCTYPE } from '../pdf/variable-catalog';
import { buildStarterElements, STARTER_PAGE, STARTER_NAME } from './starter-templates';

/** Designer variable palette: static catalog filtered by docType + tenant custom fields. */
export async function getCatalog(req: AuthRequest, res: Response) {
  try {
    const docType = String(req.query.docType ?? 'invoice') as TemplateDocType;
    if (!MODULE_FOR_DOCTYPE[docType]) return sendError(res, 'Invalid docType', 400);
    const customFieldDefs = await NativeCustomField.find({
      tenantId: req.tenantId,
      module:   MODULE_FOR_DOCTYPE[docType],
      isActive: true,
    }).select('fieldKey label fieldType').sort({ order: 1 }).lean();
    sendSuccess(res, { groups: buildCatalogForDocType(docType, customFieldDefs) });
  } catch (err: any) {
    sendError(res, err.message, 500);
  }
}

export async function list(req: AuthRequest, res: Response) {
  try {
    const { docType } = req.query;
    const filter: any = { tenantId: req.tenantId };
    if (docType) filter.docType = docType;
    const templates = await CustomTemplate.find(filter).sort({ createdAt: -1 }).lean();
    sendSuccess(res, templates);
  } catch (err: any) {
    sendError(res, err.message, 500);
  }
}

export async function getOne(req: AuthRequest, res: Response) {
  try {
    const t = await CustomTemplate.findOne({ _id: req.params.id, tenantId: req.tenantId }).lean();
    if (!t) return sendError(res, 'Not found', 404);
    sendSuccess(res, t);
  } catch (err: any) {
    sendError(res, err.message, 500);
  }
}

export async function create(req: AuthRequest, res: Response) {
  try {
    const { name, docType, elements, isDefault, page, header, footer } = req.body;
    if (!name || !docType) return sendError(res, 'name and docType are required', 400);
    if (isDefault) {
      await CustomTemplate.updateMany(
        { tenantId: req.tenantId, docType },
        { $set: { isDefault: false } }
      );
    }
    const t = await CustomTemplate.create({ tenantId: req.tenantId, name, docType, elements: elements ?? [], isDefault: !!isDefault, page, header, footer });
    res.status(201).json({ success: true, data: t });
  } catch (err: any) {
    sendError(res, err.message, 500);
  }
}

export async function update(req: AuthRequest, res: Response) {
  try {
    const { name, elements, isDefault, page, header, footer } = req.body;
    const t = await CustomTemplate.findOne({ _id: req.params.id, tenantId: req.tenantId });
    if (!t) return sendError(res, 'Not found', 404);
    if (isDefault) {
      await CustomTemplate.updateMany(
        { tenantId: req.tenantId, docType: t.docType, _id: { $ne: t._id } },
        { $set: { isDefault: false } }
      );
    }
    if (name      !== undefined) t.name      = name;
    if (elements  !== undefined) t.elements  = elements;
    if (isDefault !== undefined) t.isDefault = isDefault;
    if (page      !== undefined) t.page      = page;
    if (header    !== undefined) t.header    = header;
    if (footer    !== undefined) t.footer    = footer;
    await t.save();
    sendSuccess(res, t);
  } catch (err: any) {
    sendError(res, err.message, 500);
  }
}

export async function remove(req: AuthRequest, res: Response) {
  try {
    const t = await CustomTemplate.findOneAndDelete({ _id: req.params.id, tenantId: req.tenantId });
    if (!t) return sendError(res, 'Not found', 404);
    sendSuccess(res, null, 'Deleted');
  } catch (err: any) {
    sendError(res, err.message, 500);
  }
}

/**
 * Find-or-create the "Classic (Starter)" template for a docType — the same
 * building blocks the one-off seed-starter-templates.ts CLI script uses,
 * exposed as an on-demand, idempotent action so a tenant never has to wait
 * on someone running that script to get an editable starting point for
 * Quotation/Work Order/Contract the same way Invoice already has one.
 * Matches on the starter's own name (not "any template exists") so this
 * still works correctly even when the docType already has other,
 * non-starter templates.
 */
export async function seedStarter(req: AuthRequest, res: Response) {
  try {
    const docType = String(req.body.docType ?? req.query.docType ?? '') as TemplateDocType;
    if (!MODULE_FOR_DOCTYPE[docType]) return sendError(res, 'Invalid docType', 400);
    let t = await CustomTemplate.findOne({ tenantId: req.tenantId, docType, name: STARTER_NAME });
    if (!t) {
      t = await CustomTemplate.create({
        tenantId:  req.tenantId,
        docType,
        name:      STARTER_NAME,
        isDefault: false,
        elements:  buildStarterElements(docType),
        page:      STARTER_PAGE,
      });
    }
    sendSuccess(res, t);
  } catch (err: any) {
    sendError(res, err.message, 500);
  }
}

export async function setDefault(req: AuthRequest, res: Response) {
  try {
    const t = await CustomTemplate.findOne({ _id: req.params.id, tenantId: req.tenantId });
    if (!t) return sendError(res, 'Not found', 404);
    await CustomTemplate.updateMany(
      { tenantId: req.tenantId, docType: t.docType },
      { $set: { isDefault: false } }
    );
    t.isDefault = true;
    await t.save();
    sendSuccess(res, t);
  } catch (err: any) {
    sendError(res, err.message, 500);
  }
}
