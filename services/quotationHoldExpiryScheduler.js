import { randomUUID } from 'node:crypto';
import os from 'node:os';
import cron from 'node-cron';
import ScheduledJobRun from '../models/ScheduledJobRun.js';
import { releaseExpiredQuotationHolds } from './quotationHoldExpiryService.js';

/**
 * Leased cron runner for the quotation hold sweeper.
 *
 * Mirrors reservationExpiryScheduler: a single ScheduledJobRun lease means only
 * one instance sweeps at a time, and a heartbeat fences the run if the lease is
 * lost mid-pass so two processes can never release the same hold twice.
 */
const JOB_KEY = 'quotation-hold-expiry';
const truthy = value => ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
const positiveInteger = (value, fallback, minimum = 1) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= minimum ? parsed : fallback;
};

export function startQuotationHoldExpiryScheduler() {
  const enabled = process.env.QUOTATION_HOLD_EXPIRY_SCHEDULER_ENABLED === undefined
    ? true
    : truthy(process.env.QUOTATION_HOLD_EXPIRY_SCHEDULER_ENABLED);
  if (!enabled) {
    console.log('[quotation-hold-expiry] scheduler disabled');
    return { async stop() {} };
  }
  const schedule = String(process.env.QUOTATION_HOLD_EXPIRY_SCHEDULE || '*/15 * * * *').trim();
  if (!cron.validate(schedule)) throw new Error(`Invalid QUOTATION_HOLD_EXPIRY_SCHEDULE: ${schedule}`);
  const batchSize = positiveInteger(process.env.QUOTATION_HOLD_EXPIRY_BATCH_SIZE, 100);
  const leaseSeconds = positiveInteger(process.env.QUOTATION_HOLD_EXPIRY_LEASE_SECONDS, 300, 30);
  const leaseMs = leaseSeconds * 1000;
  const owner = `${os.hostname()}:${process.pid}:${randomUUID()}`;
  let running = false;
  let stopped = false;
  let activePromise = Promise.resolve();

  const acquire = async (startedAt) => {
    try {
      return await ScheduledJobRun.findOneAndUpdate(
        { key: JOB_KEY, $or: [{ leaseUntil: { $lte: startedAt } }, { owner }] },
        {
          $set: {
            owner,
            leaseUntil: new Date(startedAt.getTime() + leaseMs),
            heartbeatAt: startedAt,
            lastRunStartedAt: startedAt,
            lastRunStatus: 'running',
            lastError: '',
          },
          $inc: { runCount: 1 },
          $setOnInsert: { successCount: 0, failureCount: 0 },
        },
        { new: true, upsert: true, setDefaultsOnInsert: true },
      ).lean();
    } catch (error) {
      if (error?.code === 11000) return null;
      throw error;
    }
  };

  const executeRun = async () => {
    const startedAt = new Date();
    let heartbeat;
    let heartbeatInFlight = false;
    let leaseOwned = true;
    let localLeaseUntil = startedAt.getTime() + leaseMs;
    try {
      const lease = await acquire(startedAt);
      if (!lease || lease.owner !== owner) {
        console.log('[quotation-hold-expiry] skipped; lease held by another instance');
        return;
      }
      const renew = async () => {
        if (heartbeatInFlight || !leaseOwned) return;
        heartbeatInFlight = true;
        const now = new Date();
        try {
          const result = await ScheduledJobRun.updateOne(
            { key: JOB_KEY, owner, leaseUntil: { $gt: now } },
            { $set: { heartbeatAt: now, leaseUntil: new Date(now.getTime() + leaseMs) } },
          );
          if (result.matchedCount !== 1) {
            leaseOwned = false;
            console.error('[quotation-hold-expiry] lease ownership lost; fencing remaining candidates');
          } else {
            localLeaseUntil = now.getTime() + leaseMs;
          }
        } catch (error) {
          leaseOwned = false;
          console.error(`[quotation-hold-expiry] heartbeat failed; fencing remaining candidates: ${error.message}`);
        } finally {
          heartbeatInFlight = false;
        }
      };
      heartbeat = setInterval(() => { void renew(); }, Math.max(10000, Math.floor(leaseMs / 3)));
      heartbeat.unref?.();

      const result = await releaseExpiredQuotationHolds({
        now: startedAt,
        limit: batchSize,
        shouldContinue: () => !stopped && leaseOwned && Date.now() < localLeaseUntil,
      });
      const finishedAt = new Date();
      const status = result.aborted ? 'failed' : 'succeeded';
      await ScheduledJobRun.updateOne({ key: JOB_KEY, owner }, {
        $set: {
          leaseUntil: finishedAt,
          heartbeatAt: finishedAt,
          lastRunFinishedAt: finishedAt,
          lastRunStatus: status,
          lastDurationMs: finishedAt - startedAt,
          lastResult: result,
          lastError: result.aborted ? 'Run fenced because shutdown or lease ownership loss was detected.' : '',
        },
        $inc: result.aborted ? { failureCount: 1 } : { successCount: 1 },
      });
      // Only log when something actually happened, so a quiet system stays quiet.
      if (result.examined > 0 || result.aborted) {
        console.log(`[quotation-hold-expiry] run ${result.aborted ? 'fenced' : 'completed'} ${JSON.stringify(result)}`);
      }
    } catch (error) {
      const finishedAt = new Date();
      await ScheduledJobRun.updateOne(
        { key: JOB_KEY, owner },
        {
          $set: {
            leaseUntil: finishedAt, heartbeatAt: finishedAt, lastRunFinishedAt: finishedAt,
            lastRunStatus: 'failed', lastDurationMs: finishedAt - startedAt, lastError: error.message,
          },
          $inc: { failureCount: 1 },
        },
      ).catch(() => {});
      console.error(`[quotation-hold-expiry] run failed: ${error.stack || error.message}`);
    } finally {
      if (heartbeat) clearInterval(heartbeat);
    }
  };

  const run = () => {
    if (stopped || running) return activePromise;
    running = true;
    activePromise = executeRun().finally(() => { running = false; });
    return activePromise;
  };

  const task = cron.schedule(schedule, run, { noOverlap: true });
  console.log(`[quotation-hold-expiry] scheduler active schedule="${schedule}" leaseSeconds=${leaseSeconds} batch=${batchSize}`);
  if (truthy(process.env.QUOTATION_HOLD_EXPIRY_RUN_ON_START)) void run();
  return {
    async stop() {
      stopped = true;
      task.stop();
      task.destroy?.();
      await activePromise;
      console.log('[quotation-hold-expiry] scheduler stopped');
    },
  };
}

export default startQuotationHoldExpiryScheduler;
