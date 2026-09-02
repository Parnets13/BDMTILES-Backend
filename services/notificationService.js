import mongoose from 'mongoose';
import Notification from '../models/Notification.js';
import NotificationSettings from '../models/NotificationSettings.js';
import User from '../models/User.js';

const CHANNELS = ['web', 'email', 'whatsapp', 'sms', 'push'];
const uniqueStrings = (values = []) => [...new Set(values.filter(Boolean).map(String))];

const resolveRecipients = async ({ branch, roles, userIds }) => {
  const validIds = uniqueStrings(userIds).filter((id) => mongoose.isValidObjectId(id));
  const selectedRoles = uniqueStrings(roles);
  if (!validIds.length && !selectedRoles.length) return [];

  return User.find({
    status: 'Active',
    $and: [
      { $or: [{ assignedBranches: branch }, { role: { $in: ['super_admin', 'owner'] } }] },
      { $or: [{ _id: { $in: validIds } }, { role: { $in: selectedRoles } }] },
    ],
  }).select('_id role').lean();
};

const attemptsFor = (channels) => uniqueStrings(channels)
  .filter((channel) => CHANNELS.includes(channel))
  .map((channel) => channel === 'web'
    ? { channel, status: 'delivered', provider: 'inbox', attemptedAt: new Date(), deliveredAt: new Date() }
    : { channel, status: 'skipped', error: 'No delivery provider is configured.' });

export const createNotificationEvent = async ({
  branch,
  module,
  event,
  eventKey,
  title,
  body,
  data = {},
  deepLink = '',
  actor = null,
  recipientUserIds = [],
  recipientRoles = [],
  channels = [],
  respectSettings = true,
}) => {
  if (!branch || !module || !event || !eventKey || !title || !body) {
    throw new Error('branch, module, event, eventKey, title and body are required.');
  }

  let effectiveRoles = uniqueStrings(recipientRoles);
  let effectiveUsers = uniqueStrings(recipientUserIds);
  let effectiveChannels = uniqueStrings(channels);
  let eventSettings = null;

  if (respectSettings) {
    const settings = await NotificationSettings.findOne({ branch, module }).lean();
    if (!settings?.isEnabled) return { created: 0, existing: 0, skipped: true, reason: 'Module notifications are disabled.' };
    eventSettings = settings.events?.find((candidate) => candidate.eventCode === event && candidate.isEnabled);
    if (!eventSettings) return { created: 0, existing: 0, skipped: true, reason: 'Event notifications are not configured or enabled.' };
    effectiveRoles = uniqueStrings([...effectiveRoles, ...(eventSettings.recipientRoles || [])]);
    effectiveUsers = uniqueStrings([
      ...effectiveUsers,
      ...(eventSettings.recipients || []).map((recipient) => recipient.user),
    ]);
    effectiveChannels = uniqueStrings([...effectiveChannels, ...(eventSettings.channels || [])]);
  }

  if (!effectiveChannels.length) effectiveChannels = ['web'];
  const recipients = await resolveRecipients({ branch, roles: effectiveRoles, userIds: effectiveUsers });
  if (!recipients.length) return { created: 0, existing: 0, skipped: true, reason: 'No active branch recipients resolved.' };

  let created = 0;
  let existing = 0;
  for (const recipient of recipients) {
    const channelAttempts = attemptsFor(effectiveChannels);
    const deliveryState = channelAttempts.some((attempt) => attempt.status === 'delivered') ? 'delivered' : 'skipped';
    try {
      const result = await Notification.updateOne(
        { branch, eventKey, recipient: recipient._id },
        {
          $setOnInsert: {
            branch,
            module,
            event,
            eventKey,
            title,
            body,
            data,
            deepLink,
            recipient: recipient._id,
            recipientRole: recipient.role,
            deliveryState,
            channelAttempts,
            actor,
          },
        },
        { upsert: true, runValidators: true }
      );
      if (result.upsertedCount) created += 1;
      else existing += 1;
    } catch (error) {
      if (error?.code === 11000) existing += 1;
      else throw error;
    }
  }

  return { created, existing, skipped: false, recipients: recipients.length };
};

export default createNotificationEvent;
