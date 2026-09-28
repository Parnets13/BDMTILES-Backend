import { Server } from 'socket.io';
import { verifyToken } from '../utils/jwt.js';
import Dealer from '../models/Dealer.js';
import DealerEmployee from '../models/DealerEmployee.js';
import User from '../models/User.js';
import { resolveDealerEmployeePermissions } from '../config/dealerPermissions.js';
import { userHasPermission } from '../middleware/auth.js';

/**
 * Realtime chat transport (SOW 17.8).
 *
 * Replaces the polling every chat surface used to do — the dealer app at 4s, the
 * Sales Executive app at 12s/20s and the web admin at 20s. A reply now lands on
 * every open screen immediately instead of within a polling window, which also
 * removes the inconsistency where a dealer's reply could take 20 seconds to reach
 * the support desk.
 *
 * AUTHENTICATION
 *   The handshake resolves a token to one of THREE principal types, mirroring
 *   middleware/auth.js and middleware/dealerAuth.js. The checks are deliberately
 *   the same ones the REST routes make — account active, app access enabled,
 *   tokenVersion matching — so a socket can never authenticate as something the
 *   HTTP API would refuse, and a revoked session cannot keep a live socket open.
 *
 * ROOMS
 *   `dealer:<id>`  the dealer's own thread. Joined by the dealer, by a dealer
 *                  employee the dealer granted chat, and by that dealer's
 *                  assigned sales executive.
 *   `support`      the back-office desk (anyone holding `support.chat`). They see
 *                  every thread, which is what the admin screen is for.
 *
 *   A message is emitted to both. One room per dealer rather than per complaint
 *   keeps this simple and the volume is a chat thread — the client decides which
 *   open conversation a message belongs to.
 */

let io = null;

export const roomForDealer = (dealerId) => `dealer:${String(dealerId)}`;
export const SUPPORT_ROOM = 'support';

/** How many dealers one executive connection will subscribe to. */
const MAX_DEALER_ROOMS = 500;

/**
 * Resolve a handshake token to a principal, or null.
 *
 * Returns a discriminated `kind` so the room logic below cannot accidentally treat
 * a dealer as staff. `dealerId` is always taken from the token, never from the
 * client, so a connection cannot subscribe to someone else's thread.
 */
export async function resolveSocketPrincipal(token) {
  if (!token) return null;

  let decoded;
  try {
    decoded = verifyToken(token);
  } catch {
    return null;
  }

  // ── Staff ──────────────────────────────────────────────────────────────────
  if (decoded.type === 'access') {
    const user = await User.findById(decoded.userId)
      .select('name role status permissions permissionMode tokenVersion')
      .lean();
    if (!user || user.status !== 'Active') return null;
    if (!Number.isInteger(decoded.tokenVersion) || decoded.tokenVersion !== (user.tokenVersion || 0)) {
      return null;
    }
    return { kind: 'staff', userId: user._id, name: user.name, user };
  }

  // ── The dealer itself ──────────────────────────────────────────────────────
  if (decoded.type === 'dealer_access' && decoded.role === 'dealer') {
    const dealer = await Dealer.findById(decoded.dealerId)
      .select('businessName status appAccess tokenVersion')
      .lean();
    if (!dealer || dealer.status !== 'active' || !dealer.appAccess) return null;
    if (Number(decoded.tokenVersion || 0) !== Number(dealer.tokenVersion || 0)) return null;
    return { kind: 'dealer', dealerId: dealer._id, name: dealer.businessName, dealer };
  }

  // ── A dealer employee ──────────────────────────────────────────────────────
  if (decoded.type === 'dealer_employee_access' && decoded.role === 'dealer_employee') {
    const dealer = await Dealer.findById(decoded.dealerId)
      .select('businessName status appAccess employeeAccessEnabled allowEmployeeFinanceAccess tokenVersion')
      .lean();
    if (!dealer || dealer.status !== 'active' || !dealer.appAccess) return null;
    if (dealer.employeeAccessEnabled === false) return null;

    const employee = await DealerEmployee.findOne({
      _id: decoded.dealerEmployeeId,
      dealer: dealer._id,
    }).lean();
    if (!employee || employee.status !== 'active' || !employee.loginEnabled) return null;
    if (Number(decoded.tokenVersion || 0) !== Number(employee.tokenVersion || 0)) return null;

    return { kind: 'dealer_employee', dealerId: dealer._id, employeeId: employee._id, name: employee.name, employee, dealer };
  }

  return null;
}

/** Which rooms a freshly authenticated connection belongs in. */
async function roomsForPrincipal(principal) {
  if (principal.kind === 'dealer') {
    return [roomForDealer(principal.dealerId)];
  }

  if (principal.kind === 'dealer_employee') {
    // Chat is a granted permission, not a given — the same rule the REST route
    // applies. An employee without it gets no realtime feed.
    const permissions = resolveDealerEmployeePermissions(principal.employee, principal.dealer);
    const canChat = permissions.includes('chat.view') || permissions.includes('*');
    return canChat ? [roomForDealer(principal.dealerId)] : [];
  }

  const rooms = [];
  // The support desk sees every thread; that is the point of the admin screen.
  if (userHasPermission(principal.user, 'support.chat')) rooms.push(SUPPORT_ROOM);

  // An executive only hears about their own dealers.
  const dealers = await Dealer.find({ assignedSalesExecutive: principal.userId })
    .select('_id')
    .limit(MAX_DEALER_ROOMS)
    .lean();
  rooms.push(...dealers.map((dealer) => roomForDealer(dealer._id)));

  return rooms;
}

/**
 * Attach socket.io to the existing HTTP server.
 *
 * `allowedOrigins` is passed in rather than re-read here so the socket layer and
 * the REST layer cannot drift apart on CORS.
 */
export function initSocket(httpServer, { allowedOrigins = [] } = {}) {
  io = new Server(httpServer, {
    cors: {
      origin(origin, callback) {
        // No origin = a React Native client, which never sends one.
        if (!origin) return callback(null, true);
        const clean = origin.replace(/\/$/, '');
        return allowedOrigins.includes(clean)
          ? callback(null, true)
          : callback(new Error('Origin is not allowed by CORS.'));
      },
      credentials: true,
    },
    // Long enough to survive a phone switching networks, short enough to notice a
    // genuinely dead connection.
    pingTimeout: 25000,
    pingInterval: 20000,
  });

  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.token
        || socket.handshake.headers?.authorization?.replace(/^Bearer /, '');
      const principal = await resolveSocketPrincipal(token);
      if (!principal) return next(new Error('unauthorized'));
      socket.data.principal = principal;
      // Kept so the revalidation sweep can re-run the same check later.
      socket.data.token = token;
      return next();
    } catch {
      return next(new Error('unauthorized'));
    }
  });

  io.on('connection', async (socket) => {
    const principal = socket.data.principal;
    try {
      const rooms = await roomsForPrincipal(principal);
      rooms.forEach((room) => socket.join(room));
      socket.emit('ready', { rooms: rooms.length, kind: principal.kind });
    } catch {
      // A room-join failure must not leave a half-subscribed socket open.
      socket.disconnect(true);
    }
  });

  startRevalidation();

  return io;
}

/**
 * How often a connected socket re-proves it is still allowed to be here.
 *
 * Room membership is decided ONCE, at connect time, so without this a revoked
 * employee keeps receiving their dealer's chat on an already-open socket — the
 * REST API would refuse them, but the push feed would not. One query per socket
 * per minute is a cheap price for closing that.
 */
const REVALIDATE_MS = 60000;
let revalidateTimer = null;

function startRevalidation() {
  if (revalidateTimer) return;
  revalidateTimer = setInterval(async () => {
    if (!io) return;
    try {
      const sockets = await io.fetchSockets();
      await Promise.all(sockets.map(async (socket) => {
        const fresh = await resolveSocketPrincipal(socket.data?.token);
        // Covers every revocation path at once: the employee's access toggled off,
        // the dealer's app access switched off, the account deactivated, the token
        // rotated by a reset, or the record deleted.
        if (!fresh) socket.disconnect(true);
      }));
    } catch {
      // A failed sweep must never take the server down; the next one retries.
    }
  }, REVALIDATE_MS);
  revalidateTimer.unref?.();
}

/**
 * Immediately drop the sockets belonging to one dealer employee.
 *
 * The fast path for the revocations the app performs explicitly, so access ends
 * at the moment the dealer taps the switch rather than at the next sweep.
 */
export async function disconnectDealerEmployee(dealerId, employeeId) {
  if (!io) return 0;
  try {
    const sockets = await io.in(roomForDealer(dealerId)).fetchSockets();
    const doomed = sockets.filter((socket) => {
      const principal = socket.data?.principal;
      return principal?.kind === 'dealer_employee'
        && String(principal.employeeId) === String(employeeId);
    });
    doomed.forEach((socket) => socket.disconnect(true));
    return doomed.length;
  } catch {
    return 0;
  }
}

/** The instance, for tests. Null until initSocket has run. */
export const getSocket = () => io;

/**
 * Broadcast a newly created message.
 *
 * Called from a `post('save')` hook on DealerMessage rather than from each route,
 * so no write path — dealer app, Sales Executive app or support desk — can forget
 * to notify the other side. A missed emit is invisible until someone complains
 * that chat "sometimes" does not update, which is exactly the bug worth designing
 * out.
 */
export function emitNewMessage(message) {
  if (!io) return;
  const plain = typeof message?.toObject === 'function' ? message.toObject() : message;
  if (!plain?.dealer) return;

  const payload = {
    id: String(plain._id),
    dealer: String(plain.dealer),
    complaint: plain.complaint ? String(plain.complaint) : null,
    senderRole: plain.senderRole,
    senderName: plain.senderName || '',
    salesExecutive: plain.salesExecutive ? String(plain.salesExecutive) : null,
    body: plain.body,
    createdAt: plain.createdAt,
  };

  io.to(roomForDealer(plain.dealer)).emit('message:new', payload);
  io.to(SUPPORT_ROOM).emit('message:new', payload);
}

export default {
  initSocket,
  emitNewMessage,
  getSocket,
  resolveSocketPrincipal,
  disconnectDealerEmployee,
  roomForDealer,
  SUPPORT_ROOM,
};
