'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const pino = require('pino');
const QRCode = require('qrcode');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '256kb' }));

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const AUTH_DIR = path.resolve(process.env.AUTH_DIR || './auth_info');
const DATA_DIR = path.resolve(process.env.DATA_DIR || './data');
const API_TOKEN = process.env.CONNECTOR_API_TOKEN || '';
const DEFAULT_COUNTRY = String(process.env.DEFAULT_COUNTRY || '91').replace(/\D/g, '');
const OTP_TTL_MS = Math.max(60, Number(process.env.OTP_TTL_SECONDS || 300)) * 1000;
const OTP_COOLDOWN_MS = Math.max(30, Number(process.env.OTP_COOLDOWN_SECONDS || 60)) * 1000;
const OTP_MAX_PER_HOUR = Math.max(1, Number(process.env.OTP_MAX_PER_HOUR || 5));
const OTP_MAX_ATTEMPTS = Math.max(1, Number(process.env.OTP_MAX_ATTEMPTS || 5));
const OTP_PEPPER = process.env.OTP_PEPPER || '';
const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

fs.mkdirSync(AUTH_DIR, { recursive: true });
fs.mkdirSync(DATA_DIR, { recursive: true });

let sock = null;
let connectionState = 'disconnected';
let latestQR = null;
let lastDisconnect = null;
let reconnectTimer = null;
let manualDisconnect = false;
const otpStore = new Map();
const otpSendTimes = new Map();

app.use((req, res, next) => {
  if (!API_TOKEN || req.path === '/health' || req.path === '/') return next();
  const provided = String(req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!provided || !crypto.timingSafeEqual(Buffer.from(provided.padEnd(API_TOKEN.length).slice(0, API_TOKEN.length)), Buffer.from(API_TOKEN))) {
    return res.status(401).json({ ok: false, error: 'Unauthorized. Configure CONNECTOR_API_TOKEN and send Authorization: Bearer <token>.' });
  }
  next();
});

function normalizeNumber(input) {
  let n = String(input || '').replace(/\D/g, '');
  if (n.startsWith('00')) n = n.slice(2);
  if (n.length === 10 && DEFAULT_COUNTRY) n = DEFAULT_COUNTRY + n;
  if (n.length < 10 || n.length > 15) return null;
  return n;
}

function getJid(input) {
  const number = normalizeNumber(input);
  return number ? number + '@s.whatsapp.net' : null;
}

function hashOtp(number, code) {
  return crypto.createHmac('sha256', OTP_PEPPER || 'change-this-otp-pepper')
    .update(number + ':' + code).digest('hex');
}

function safeEqualHex(a, b) {
  const aa = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}

function cleanupOtps() {
  const now = Date.now();
  for (const [number, record] of otpStore) {
    if (record.expiresAt <= now || record.used) otpStore.delete(number);
  }
  for (const [number, times] of otpSendTimes) {
    const fresh = times.filter(t => now - t < 3600000);
    if (fresh.length) otpSendTimes.set(number, fresh);
    else otpSendTimes.delete(number);
  }
}

async function connectWhatsApp() {
  if (sock && ['connecting', 'connected'].includes(connectionState)) return;
  manualDisconnect = false;
  connectionState = 'connecting';
  try {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    let version;
    try {
      const latest = await fetchLatestBaileysVersion();
      version = latest.version;
    } catch (_) {
      logger.warn('Could not fetch latest WhatsApp Web version; using library default.');
    }

    sock = makeWASocket({
      ...(version ? { version } : {}),
      auth: state,
      logger: pino({ level: 'silent' }),
      printQRInTerminal: false,
      browser: ['Ubuntu', 'Chrome', '120.0.0'],
      markOnlineOnConnect: false,
      syncFullHistory: false,
      generateHighQualityLinkPreview: false
    });

    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', async update => {
      const { connection, lastDisconnect: disconnect, qr } = update;
      if (qr) {
        latestQR = qr;
        logger.info('QR code is ready. Open GET /qr to display it.');
      }
      if (connection === 'open') {
        connectionState = 'connected';
        latestQR = null;
        lastDisconnect = null;
        logger.info('WhatsApp connected.');
      }
      if (connection === 'close') {
        connectionState = 'disconnected';
        lastDisconnect = disconnect?.error?.message || 'Connection closed';
        const statusCode = disconnect?.error?.output?.statusCode;
        sock = null;
        if (!manualDisconnect && statusCode !== DisconnectReason.loggedOut) {
          clearTimeout(reconnectTimer);
          reconnectTimer = setTimeout(connectWhatsApp, 5000);
        } else if (statusCode === DisconnectReason.loggedOut) {
          logger.warn('Logged out. Clear auth_info only if you intend to pair again.');
        }
      }
    });
  } catch (error) {
    connectionState = 'disconnected';
    sock = null;
    logger.error({ err: error }, 'WhatsApp connection failed');
    throw error;
  }
}

app.get('/', (_req, res) => res.json({
  name: 'RB WhatsApp Connector',
  version: '1.0.0',
  platform: 'Ubuntu/Linux',
  features: ['QR connection', 'pairing code', 'send message', 'OTP request', 'OTP verification'],
  endpoints: ['/health', '/status', '/connect', '/qr', '/pair', '/send-message', '/otp/request', '/otp/verify', '/disconnect']
}));

app.get('/health', (_req, res) => res.json({ ok: true, status: 'healthy', platform: process.platform }));
app.get('/status', (_req, res) => res.json({
  ok: true,
  connection: connectionState,
  qrReady: Boolean(latestQR),
  lastDisconnect,
  otpService: 'enabled'
}));

app.post('/connect', async (_req, res) => {
  try {
    await connectWhatsApp();
    res.json({ ok: true, message: 'Connection starting. Check GET /qr and GET /status.' });
  } catch (error) {
    res.status(500).json({ ok: false, error: 'Could not start WhatsApp connection.' });
  }
});

app.get('/qr', async (_req, res) => {
  if (connectionState === 'connected') return res.json({ ok: true, connected: true, message: 'WhatsApp is already connected.' });
  if (!latestQR) return res.status(404).json({ ok: false, error: 'QR not ready. POST /connect first, then retry.' });
  try {
    const dataUrl = await QRCode.toDataURL(latestQR, { width: 360, margin: 2 });
    res.json({ ok: true, qr: latestQR, dataUrl });
  } catch (_) {
    res.status(500).json({ ok: false, error: 'Unable to create QR image.' });
  }
});

app.post('/pair', async (req, res) => {
  const number = normalizeNumber(req.body?.number);
  if (!number) return res.status(400).json({ ok: false, error: 'Provide a valid phone number with country code.' });
  if (connectionState === 'connected' && sock?.user) return res.status(409).json({ ok: false, error: 'Already connected.' });
  try {
    await connectWhatsApp();
    if (!sock?.requestPairingCode) return res.status(503).json({ ok: false, error: 'Pairing code is not ready yet. Retry shortly.' });
    const code = await sock.requestPairingCode(number);
    res.json({ ok: true, code, number, message: 'Enter this code in WhatsApp Linked Devices.' });
  } catch (_) {
    res.status(500).json({ ok: false, error: 'Could not generate pairing code.' });
  }
});

app.post('/send-message', async (req, res) => {
  const jid = getJid(req.body?.to);
  const message = String(req.body?.message || '').trim();
  if (!jid) return res.status(400).json({ ok: false, error: 'Invalid recipient number.' });
  if (!message || message.length > 4000) return res.status(400).json({ ok: false, error: 'Message is required and must be under 4000 characters.' });
  if (connectionState !== 'connected' || !sock) return res.status(503).json({ ok: false, error: 'WhatsApp is not connected.' });
  try {
    const sent = await sock.sendMessage(jid, { text: message });
    res.json({ ok: true, messageId: sent?.key?.id || null });
  } catch (_) {
    res.status(502).json({ ok: false, error: 'Message could not be sent.' });
  }
});

async function requestOtp(req, res) {
  cleanupOtps();
  const number = normalizeNumber(req.body?.to || req.body?.number);
  if (!number) return res.status(400).json({ ok: false, error: 'Provide a valid phone number with country code.' });
  if (connectionState !== 'connected' || !sock) return res.status(503).json({ ok: false, error: 'WhatsApp is not connected.' });

  const now = Date.now();
  const previous = otpStore.get(number);
  if (previous && now - previous.createdAt < OTP_COOLDOWN_MS) {
    return res.status(429).json({ ok: false, error: 'Please wait before requesting another OTP.' });
  }
  const sentTimes = (otpSendTimes.get(number) || []).filter(t => now - t < 3600000);
  if (sentTimes.length >= OTP_MAX_PER_HOUR) {
    return res.status(429).json({ ok: false, error: 'OTP request limit reached for this number. Try again later.' });
  }

  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  const expiresAt = now + OTP_TTL_MS;
  const record = { hash: hashOtp(number, code), createdAt: now, expiresAt, attempts: 0, used: false };
  otpStore.set(number, record);

  try {
    await sock.sendMessage(number + '@s.whatsapp.net', {
      text: 'Your verification code is ' + code + '. It expires in ' + Math.floor(OTP_TTL_MS / 60000) + ' minute(s). Do not share this code with anyone.'
    });
    sentTimes.push(now);
    otpSendTimes.set(number, sentTimes);
    res.json({ ok: true, message: 'OTP sent through WhatsApp.', expiresInSeconds: Math.floor(OTP_TTL_MS / 1000) });
  } catch (_) {
    otpStore.delete(number);
    res.status(502).json({ ok: false, error: 'OTP could not be delivered. Check the number and connection.' });
  }
}

function verifyOtp(req, res) {
  cleanupOtps();
  const number = normalizeNumber(req.body?.to || req.body?.number);
  const code = String(req.body?.otp || req.body?.code || '').trim();
  if (!number || !/^\d{6}$/.test(code)) return res.status(400).json({ ok: false, error: 'Provide a valid number and 6-digit OTP.' });
  const record = otpStore.get(number);
  if (!record || record.expiresAt <= Date.now() || record.used) {
    otpStore.delete(number);
    return res.status(400).json({ ok: false, verified: false, error: 'OTP is invalid or expired. Request a new one.' });
  }
  record.attempts += 1;
  if (record.attempts > OTP_MAX_ATTEMPTS) {
    otpStore.delete(number);
    return res.status(429).json({ ok: false, verified: false, error: 'Too many verification attempts. Request a new OTP.' });
  }
  if (!safeEqualHex(record.hash, hashOtp(number, code))) {
    return res.status(400).json({ ok: false, verified: false, error: 'Incorrect OTP.' });
  }
  record.used = true;
  otpStore.delete(number);
  res.json({ ok: true, verified: true, message: 'Phone number verified successfully.' });
}

app.post('/otp/request', requestOtp);
app.post('/otp/verify', verifyOtp);
app.post('/send-otp', requestOtp);
app.post('/verify-otp', verifyOtp);

app.post('/disconnect', async (_req, res) => {
  manualDisconnect = true;
  clearTimeout(reconnectTimer);
  latestQR = null;
  if (sock) {
    try { await sock.logout(); } catch (_) { try { sock.end(undefined); } catch (_) {} }
  }
  sock = null;
  connectionState = 'disconnected';
  res.json({ ok: true, message: 'Disconnected. Session files are kept on disk.' });
});

app.use((err, _req, res, _next) => {
  logger.error({ err }, 'Request error');
  res.status(400).json({ ok: false, error: 'Invalid request.' });
});

app.listen(PORT, HOST, () => {
  logger.info({ host: HOST, port: PORT }, 'RB WhatsApp Connector started');
  if (process.env.AUTO_CONNECT === 'true') connectWhatsApp().catch(() => {});
});

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
function shutdown() {
  manualDisconnect = true;
  clearTimeout(reconnectTimer);
  try { sock?.end(undefined); } catch (_) {}
  process.exit(0);
}
