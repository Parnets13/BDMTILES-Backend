import Delivery from '../models/Delivery.js';

const lineageError = message => Object.assign(new Error(message), { status: 422 });
const id = value => String(value?._id || value || '');

export async function lockSalesReturnLineage(items, branch, session) {
  if (!session) throw Object.assign(new Error('Sales Return lineage locking requires an active transaction.'), { status: 500 });
  const deliveryIds = [...new Set((items || []).map(item => id(item.delivery)).filter(Boolean))].sort();
  for (const deliveryId of deliveryIds) {
    const result = await Delivery.updateOne(
      { _id: deliveryId, branch },
      { $inc: { salesReturnClaimVersion: 1 } },
      { session }
    );
    if (result.matchedCount !== 1) throw lineageError('A supplied Delivery is unavailable for Sales Return allocation.');
  }
}

export async function resolveSalesReturnDeliveryLineage({ branch, invoice, invoiceItem, requested = {}, session = null }) {
  const supplied = requested.delivery || requested.deliveryItem || requested.discrepancy || requested.returnContext;
  if (!supplied) return { lineage: { returnContext: 'legacy_invoice' }, allowance: null };
  if (!requested.delivery || !requested.deliveryItem) {
    throw lineageError('delivery and deliveryItem are both required when delivery lineage is supplied.');
  }
  let query = Delivery.findOne({
    _id: requested.delivery,
    branch,
    salesOrder: invoice.salesOrder,
    'items._id': requested.deliveryItem,
  }).select('items discrepancies status');
  if (session) query = query.session(session);
  const delivery = await query.lean();
  if (!delivery) throw lineageError('The supplied Delivery does not belong to this branch and Sales Order.');
  const deliveryItem = (delivery.items || []).find(item => id(item._id) === id(requested.deliveryItem));
  if (!deliveryItem || !invoiceItem.salesOrderItem || id(deliveryItem.salesOrderItem) !== id(invoiceItem.salesOrderItem)
      || id(deliveryItem.product) !== id(invoiceItem.product)) {
    throw lineageError('The supplied delivery item does not match the selected invoice/Sales Order line.');
  }
  let discrepancy;
  if (requested.discrepancy) {
    discrepancy = (delivery.discrepancies || []).find(row => id(row._id) === id(requested.discrepancy));
    if (!discrepancy || id(discrepancy.deliveryItem) !== id(deliveryItem._id)) {
      throw lineageError('The supplied discrepancy does not belong to the selected delivery item.');
    }
  }
  const context = discrepancy ? 'delivery_discrepancy' : 'customer_accepted';
  if (requested.returnContext && requested.returnContext !== context) throw lineageError('returnContext does not match the verified delivery lineage.');
  const factor = Number(deliveryItem.conversionFactor || 1);
  const enteredAllowance = Number(discrepancy ? discrepancy.boxes : deliveryItem.acceptedQuantity || 0);
  return {
    lineage: {
      delivery: delivery._id,
      deliveryItem: deliveryItem._id,
      discrepancy: discrepancy?._id,
      returnContext: context,
    },
    allowance: {
      key: discrepancy ? id(discrepancy._id) : id(deliveryItem._id),
      enteredQuantity: enteredAllowance,
      baseQuantity: enteredAllowance * factor,
      baseUnit: deliveryItem.baseUnit || deliveryItem.enteredUnit || invoiceItem.baseUnit || invoiceItem.unit || 'Unit',
      context,
    },
  };
}

export default resolveSalesReturnDeliveryLineage;
