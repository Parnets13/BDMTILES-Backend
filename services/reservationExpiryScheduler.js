import { randomUUID } from 'node:crypto';
import os from 'node:os';
import cron from 'node-cron';
import ScheduledJobRun from '../models/ScheduledJobRun.js';
import { releaseExpiredApprovalReservations } from './reservationExpiryService.js';

const JOB_KEY = 'reservation-expiry';
const truthy = value => ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
const positiveInteger = (value, fallback, minimum = 1) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= minimum ? parsed : fallback;
};

export function startReservationExpiryScheduler() {
  const enabled = process.env.RESERVATION_EXPIRY_SCHEDULER_ENABLED === undefined
    ? true
    : truthy(process.env.RESERVATION_EXPIRY_SCHEDULER_ENABLED);
  if (!enabled) {
    console.log('[reservation-expiry] scheduler disabled');
    return { async stop() {} };
  }
  const schedule = String(process.env.RESERVATION_EXPIRY_SCHEDULE || '*/5 * * * *').trim();
  if (!cron.validate(schedule)) throw new Error(`Invalid RESERVATION_EXPIRY_SCHEDULE: ${schedule}`);
  const batchSize = positiveInteger(process.env.RESERVATION_EXPIRY_BATCH_SIZE, 100);
  const leaseSeconds = positiveInteger(process.env.RESERVATION_EXPIRY_LEASE_SECONDS, 300, 30);
  const leaseMs = leaseSeconds * 1000;
  const owner = `${os.hostname()}:${process.pid}:${randomUUID()}`;
  let running = false;
  let stopped = false;
  let activePromise = Promise.resolve();

  const acquire = async startedAt => {
    try {
      return await ScheduledJobRun.findOneAndUpdate(
        { key: JOB_KEY, $or: [{ leaseUntil: { $lte: startedAt } }, { owner }] },
        {
          $set: { owner, leaseUntil: new Date(startedAt.getTime() + leaseMs), heartbeatAt: startedAt, lastRunStartedAt: startedAt, lastRunStatus: 'running', lastError: '' },
          $inc: { runCount: 1 },
          $setOnInsert: { successCount: 0, failureCount: 0 },
        },
        { new: true, upsert: true, setDefaultsOnInsert: true }
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
        console.log('[reservation-expiry] skipped; lease held by another instance');
        return;
      }
      console.log(`[reservation-expiry] run started owner=${owner} batch=${batchSize}`);
      const renew = async () => {
        if (heartbeatInFlight || !leaseOwned) return;
        heartbeatInFlight = true;
        const now = new Date();
        try {
          const result = await ScheduledJobRun.updateOne(
            { key: JOB_KEY, owner, leaseUntil: { $gt: now } },
            { $set: { heartbeatAt: now, leaseUntil: new Date(now.getTime() + leaseMs) } }
          );
          if (result.matchedCount !== 1) {
            leaseOwned = false;
            console.error('[reservation-expiry] lease ownership lost; fencing remaining candidates');
          } else {
            localLeaseUntil = now.getTime() + leaseMs;
          }
        } catch (error) {
          leaseOwned = false;
          console.error(`[reservation-expiry] heartbeat failed; fencing remaining candidates: ${error.message}`);
        } finally {
          heartbeatInFlight = false;
        }
      };
      heartbeat = setInterval(() => { void renew(); }, Math.max(10000, Math.floor(leaseMs / 3)));
      heartbeat.unref?.();
      const result = await releaseExpiredApprovalReservations({
        now: startedAt,
        limit: batchSize,
        shouldContinue: () => !stopped && leaseOwned && Date.now() < localLeaseUntil,
      });
      const finishedAt = new Date();
      const status = result.aborted ? 'failed' : 'succeeded';
      const update = {
        $set: {
          leaseUntil: finishedAt, heartbeatAt: finishedAt, lastRunFinishedAt: finishedAt,
          lastRunStatus: status, lastDurationMs: finishedAt - startedAt, lastResult: result,
          lastError: result.aborted ? 'Run fenced because shutdown or lease ownership loss was detected.' : '',
        },
        $inc: result.aborted ? { failureCount: 1 } : { successCount: 1 },
      };
      await ScheduledJobRun.updateOne({ key: JOB_KEY, owner }, update);
      console.log(`[reservation-expiry] run ${result.aborted ? 'fenced' : 'completed'} ${JSON.stringify(result)}`);
    } catch (error) {
      const finishedAt = new Date();
      await ScheduledJobRun.updateOne(
        { key: JOB_KEY, owner },
        { $set: { leaseUntil: finishedAt, heartbeatAt: finishedAt, lastRunFinishedAt: finishedAt, lastRunStatus: 'failed', lastDurationMs: finishedAt - startedAt, lastError: error.message }, $inc: { failureCount: 1 } }
      ).catch(() => {});
      console.error(`[reservation-expiry] run failed: ${error.stack || error.message}`);
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
  console.log(`[reservation-expiry] scheduler active schedule="${schedule}" leaseSeconds=${leaseSeconds} batch=${batchSize}`);
  if (truthy(process.env.RESERVATION_EXPIRY_RUN_ON_START)) void run();
  return {
    async stop() {
      stopped = true;
      task.stop();
      task.destroy?.();
      await activePromise;
      console.log('[reservation-expiry] scheduler stopped');
    },
  };
}

export default startReservationExpiryScheduler;
