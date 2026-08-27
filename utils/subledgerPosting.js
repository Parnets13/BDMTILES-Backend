import Dealer from '../models/Dealer.js';
import Supplier from '../models/Supplier.js';
import DealerLedger from '../models/DealerLedger.js';
import SupplierLedger from '../models/SupplierLedger.js';

const PARTY_CONFIG = {
  dealer: {
    Party: Dealer,
    Ledger: DealerLedger,
    partyField: 'dealer',
    nameField: 'businessName',
    codeField: 'dealerCode',
    ledgerNameField: 'dealerName',
    ledgerCodeField: 'dealerCode',
  },
  supplier: {
    Party: Supplier,
    Ledger: SupplierLedger,
    partyField: 'supplier',
    nameField: 'companyName',
    codeField: 'supplierCode',
    ledgerNameField: 'supplierName',
    ledgerCodeField: 'supplierCode',
  },
};

function postingError(status, message, code) {
  const error = new Error(message);
  error.status = status;
  if (code) error.code = code;
  return error;
}

function positiveAmount(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw postingError(422, 'Subledger posting amount must be a finite number greater than zero.');
  }
  return amount;
}

function requiredString(value, field) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized) throw postingError(422, `${field} is required.`);
  return normalized;
}

/**
 * Appends one branch subledger entry and updates the consolidated party cache.
 * The caller owns the transaction and must pass its active session.
 *
 * For reversals, reversalOfPostingKey identifies the original row. Its amount and
 * debit/credit direction are copied and swapped; callers cannot invent a second
 * reversal amount or direction.
 */
export async function postSubledgerEntry({
  session,
  branch,
  partyType,
  partyId,
  amount,
  side,
  postingKey,
  reversalOfPostingKey,
  entryType,
  entryDate,
  description = '',
  referenceNumber,
  referenceModel,
  referenceId,
  createdBy,
}) {
  if (!session || !session.inTransaction()) {
    throw postingError(500, 'An active MongoDB transaction session is required for subledger posting.');
  }
  if (!branch) throw postingError(422, 'Subledger posting branch is required.');
  if (!partyId) throw postingError(422, 'Subledger posting party is required.');

  const config = PARTY_CONFIG[partyType];
  if (!config) throw postingError(422, 'partyType must be dealer or supplier.');

  const normalizedPostingKey = requiredString(postingKey, 'postingKey');
  const party = await config.Party.findById(partyId)
    .select(`${config.nameField} ${config.codeField}`)
    .session(session)
    .lean();
  if (!party) throw postingError(409, `${partyType === 'dealer' ? 'Dealer' : 'Supplier'} no longer exists.`);

  let postingAmount;
  let postingSide;
  let reversalOf;
  if (reversalOfPostingKey) {
    const originalKey = requiredString(reversalOfPostingKey, 'reversalOfPostingKey');
    const original = await config.Ledger.findOne({
      branch,
      [config.partyField]: partyId,
      postingKey: originalKey,
    }).session(session).lean();
    if (!original) {
      throw postingError(409, `Cannot reverse missing subledger posting "${originalKey}".`, 'SUBLEDGER_REVERSAL_SOURCE_MISSING');
    }

    const originalDebit = Number(original.debit || 0);
    const originalCredit = Number(original.credit || 0);
    if ((originalDebit > 0) === (originalCredit > 0)) {
      throw postingError(409, `Subledger posting "${originalKey}" is not a valid one-sided entry.`);
    }
    postingAmount = positiveAmount(originalDebit > 0 ? originalDebit : originalCredit);
    postingSide = originalDebit > 0 ? 'credit' : 'debit';
    reversalOf = original._id;
  } else {
    postingAmount = positiveAmount(amount);
    if (!['debit', 'credit'].includes(side)) {
      throw postingError(422, 'Subledger posting side must be debit or credit.');
    }
    postingSide = side;
  }

  const entry = {
    branch,
    [config.partyField]: partyId,
    [config.ledgerNameField]: party[config.nameField],
    [config.ledgerCodeField]: party[config.codeField],
    entryType,
    entryDate: entryDate || new Date(),
    description,
    referenceNumber,
    referenceModel,
    referenceId,
    postingKey: normalizedPostingKey,
    reversalOf,
    debit: postingSide === 'debit' ? postingAmount : 0,
    credit: postingSide === 'credit' ? postingAmount : 0,
    createdBy,
  };

  let ledgerEntry;
  try {
    [ledgerEntry] = await config.Ledger.create([entry], { session });
  } catch (error) {
    if (error?.code === 11000) {
      throw postingError(
        409,
        `Subledger posting "${normalizedPostingKey}" already exists for this branch.`,
        'SUBLEDGER_POSTING_CONFLICT'
      );
    }
    throw error;
  }

  const cacheDelta = partyType === 'dealer'
    ? (postingSide === 'debit' ? postingAmount : -postingAmount)
    : (postingSide === 'credit' ? postingAmount : -postingAmount);
  const cacheUpdate = await config.Party.updateOne(
    { _id: partyId },
    { $inc: { currentOutstanding: cacheDelta } },
    { session }
  );
  if (cacheUpdate.matchedCount !== 1) {
    throw postingError(409, `${partyType === 'dealer' ? 'Dealer' : 'Supplier'} no longer exists.`);
  }

  return ledgerEntry;
}
