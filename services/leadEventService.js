const clients = new Map();

const keyFor = (branchId) => String(branchId);
const send = (response, event, data) => {
  response.write(`event: ${event}\n`);
  response.write(`data: ${JSON.stringify(data)}\n\n`);
};

export const addLeadEventClient = ({ branchId, userId, role, response }) => {
  const key = keyFor(branchId);
  const client = { userId: String(userId), role, response };
  if (!clients.has(key)) clients.set(key, new Set());
  clients.get(key).add(client);
  send(response, 'ready', { connected: true, branchId: key });

  const heartbeat = setInterval(() => {
    try { response.write(': heartbeat\n\n'); } catch { clearInterval(heartbeat); }
  }, 25000);

  return () => {
    clearInterval(heartbeat);
    const branchClients = clients.get(key);
    branchClients?.delete(client);
    if (!branchClients?.size) clients.delete(key);
  };
};

export const publishLeadEvent = ({ branchId, userIds = [], event = 'lead.changed', data = {} }) => {
  const targets = new Set((userIds || []).filter(Boolean).map(String));
  for (const client of clients.get(keyFor(branchId)) || []) {
    if (targets.size && !targets.has(client.userId)) continue;
    if (!targets.size && client.role === 'sales_executive') continue;
    try { send(client.response, event, { ...data, emittedAt: new Date().toISOString() }); } catch { /* request cleanup removes it */ }
  }
};

export default publishLeadEvent;
