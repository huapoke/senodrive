import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const PORT = Number(process.env.PORT || 8787);
const ROOT = process.cwd();
const DATA_DIR = path.join(ROOT, 'secure-data');
const UPLOAD_DIR = path.join(DATA_DIR, 'verification-documents');
const BOOKINGS_FILE = path.join(DATA_DIR, 'bookings.json');
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || `http://127.0.0.1:${PORT}`;

const STATUS_VALUES = new Set(['Pending Verification', 'Verified', 'Rejected']);
const ALLOWED_TYPES = new Set(['image/jpeg', 'image/png', 'application/pdf']);
const MAX_BODY_BYTES = 15 * 1024 * 1024;
const MIN_FILE_BYTES = 50 * 1024;
const MAX_FILE_BYTES = 10 * 1024 * 1024;

async function ensureStorage() {
  await fs.mkdir(UPLOAD_DIR, { recursive: true });
  try {
    await fs.access(BOOKINGS_FILE);
  } catch {
    await fs.writeFile(BOOKINGS_FILE, '[]');
  }
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json',
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,POST,PATCH,OPTIONS',
    'access-control-allow-headers': 'content-type'
  });
  res.end(JSON.stringify(body));
}

function sendText(res, status, body, contentType = 'text/plain') {
  res.writeHead(status, {
    'content-type': contentType,
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,POST,PATCH,OPTIONS',
    'access-control-allow-headers': 'content-type'
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('Request too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function safeFileName(name) {
  return String(name || 'document').replace(/[^a-z0-9._-]/gi, '-').slice(0, 90);
}

function parseDataUrl(dataUrl) {
  const match = /^data:([^;]+);base64,(.+)$/i.exec(String(dataUrl || ''));
  if (!match) throw new Error('Invalid document upload. Please upload the file again.');

  const mimeType = match[1].toLowerCase();
  if (!ALLOWED_TYPES.has(mimeType)) {
    throw new Error('Only JPG, PNG, or PDF documents are accepted.');
  }

  const buffer = Buffer.from(match[2], 'base64');
  if (buffer.length < MIN_FILE_BYTES) {
    throw new Error('The uploaded document is too small or unclear.');
  }
  if (buffer.length > MAX_FILE_BYTES) {
    throw new Error('The uploaded document must be under 10 MB.');
  }

  const isJpeg = mimeType === 'image/jpeg' && buffer[0] === 0xff && buffer[1] === 0xd8;
  const isPng = mimeType === 'image/png' && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const isPdf = mimeType === 'application/pdf' && buffer.subarray(0, 4).toString() === '%PDF';

  if (!isJpeg && !isPng && !isPdf) {
    throw new Error('The uploaded document appears unreadable or corrupted.');
  }

  return { mimeType, buffer };
}

async function readBookings() {
  await ensureStorage();
  return JSON.parse(await fs.readFile(BOOKINGS_FILE, 'utf8'));
}

async function writeBookings(bookings) {
  await fs.writeFile(BOOKINGS_FILE, JSON.stringify(bookings, null, 2));
}

function requireField(payload, name, label) {
  const value = String(payload[name] || '').trim();
  if (!value) throw new Error(`${label} is required.`);
  return value;
}

function bookingMessage(booking) {
  return [
    'New booking confirmation request',
    '',
    `Booking ID: ${booking.id}`,
    `Status: ${booking.status}`,
    `Customer name: ${booking.customerName}`,
    `Customer phone: ${booking.customerPhone}`,
    `Pickup: ${booking.pickup}`,
    `Destination: ${booking.destination}`,
    `Date: ${booking.date}`,
    `Time: ${booking.time}`,
    `Passengers: ${booking.passengers}`,
    '',
    `Verification document: ${booking.document.originalName}`,
    `View/download: ${PUBLIC_BASE_URL}${booking.document.url}`,
    '',
    'Please verify this passport or government-issued ID immediately.'
  ].join('\n');
}

async function notifyWebhook(booking, documentBase64) {
  if (!process.env.ADMIN_WEBHOOK_URL) return { skipped: true };

  const response = await fetch(process.env.ADMIN_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'booking.created',
      booking,
      document: {
        ...booking.document,
        base64: documentBase64
      }
    })
  });

  if (!response.ok) throw new Error(`Webhook notification failed: ${response.status}`);
  return { sent: true };
}

async function notifySendGrid(booking, documentBase64) {
  if (!process.env.SENDGRID_API_KEY || !process.env.ADMIN_EMAIL || !process.env.FROM_EMAIL) {
    return { skipped: true };
  }

  const response = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${process.env.SENDGRID_API_KEY}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: process.env.ADMIN_EMAIL }] }],
      from: { email: process.env.FROM_EMAIL },
      subject: `New booking confirmation: ${booking.customerName}`,
      content: [{ type: 'text/plain', value: bookingMessage(booking) }],
      attachments: [{
        content: documentBase64,
        filename: booking.document.originalName,
        type: booking.document.mimeType,
        disposition: 'attachment'
      }]
    })
  });

  if (!response.ok) throw new Error(`Email notification failed: ${response.status}`);
  return { sent: true };
}

async function notifyWhatsApp(booking) {
  if (!process.env.WHATSAPP_TOKEN || !process.env.WHATSAPP_PHONE_NUMBER_ID || !process.env.ADMIN_WHATSAPP_NUMBER) {
    return { skipped: true };
  }

  const response = await fetch(`https://graph.facebook.com/v19.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to: process.env.ADMIN_WHATSAPP_NUMBER,
      type: 'text',
      text: { body: bookingMessage(booking) }
    })
  });

  if (!response.ok) throw new Error(`WhatsApp notification failed: ${response.status}`);
  return { sent: true };
}

async function notifyAdmin(booking, documentBuffer) {
  const documentBase64 = documentBuffer.toString('base64');
  const results = await Promise.allSettled([
    notifyWebhook(booking, documentBase64),
    notifySendGrid(booking, documentBase64),
    notifyWhatsApp(booking)
  ]);

  return results.map((result) => result.status === 'fulfilled'
    ? result.value
    : { error: result.reason.message });
}

async function createBooking(req, res) {
  try {
    const payload = JSON.parse(await readBody(req));
    const customerName = requireField(payload, 'customerName', 'Customer name');
    const customerPhone = requireField(payload, 'customerPhone', 'Customer phone number');
    const pickup = requireField(payload, 'pickup', 'Pickup location');
    const destination = requireField(payload, 'destination', 'Destination');
    const date = requireField(payload, 'date', 'Date');
    const time = requireField(payload, 'formattedTime', 'Time');
    const passengers = requireField(payload, 'passengers', 'Passenger count');

    if (!payload.document?.dataUrl) {
      throw new Error('Passport photo or government-issued ID card photo is required.');
    }

    const { mimeType, buffer } = parseDataUrl(payload.document.dataUrl);
    const id = crypto.randomUUID();
    const extension = mimeType === 'application/pdf' ? '.pdf' : mimeType === 'image/png' ? '.png' : '.jpg';
    const originalName = safeFileName(payload.document.name || `verification${extension}`);
    const storedName = `${id}-${originalName.endsWith(extension) ? originalName : `${originalName}${extension}`}`;
    const diskPath = path.join(UPLOAD_DIR, storedName);
    await fs.writeFile(diskPath, buffer, { flag: 'wx' });

    const booking = {
      id,
      status: 'Pending Verification',
      createdAt: new Date().toISOString(),
      customerName,
      customerPhone,
      pickup,
      destination,
      date,
      time,
      passengers,
      document: {
        originalName,
        storedName,
        mimeType,
        bytes: buffer.length,
        url: `/api/bookings/${id}/document`
      }
    };

    const bookings = await readBookings();
    bookings.unshift(booking);
    await writeBookings(bookings);

    const notifications = await notifyAdmin(booking, buffer);
    sendJson(res, 201, { booking, notifications });
  } catch (error) {
    sendJson(res, 400, { error: error.message });
  }
}

async function listBookings(_req, res) {
  const bookings = await readBookings();
  sendJson(res, 200, { bookings });
}

async function updateBookingStatus(req, res, id) {
  try {
    const payload = JSON.parse(await readBody(req));
    if (!STATUS_VALUES.has(payload.status)) throw new Error('Invalid booking status.');

    const bookings = await readBookings();
    const booking = bookings.find((item) => item.id === id);
    if (!booking) return sendJson(res, 404, { error: 'Booking not found.' });

    booking.status = payload.status;
    booking.updatedAt = new Date().toISOString();
    await writeBookings(bookings);
    sendJson(res, 200, { booking });
  } catch (error) {
    sendJson(res, 400, { error: error.message });
  }
}

async function downloadDocument(_req, res, id) {
  const bookings = await readBookings();
  const booking = bookings.find((item) => item.id === id);
  if (!booking) return sendText(res, 404, 'Booking not found.');

  const diskPath = path.join(UPLOAD_DIR, booking.document.storedName);
  try {
    const buffer = await fs.readFile(diskPath);
    res.writeHead(200, {
      'content-type': booking.document.mimeType,
      'content-disposition': `attachment; filename="${booking.document.originalName}"`,
      'access-control-allow-origin': '*'
    });
    res.end(buffer);
  } catch {
    sendText(res, 404, 'Document not found.');
  }
}

async function serveFile(res, filePath, contentType) {
  try {
    const body = await fs.readFile(path.join(ROOT, filePath));
    sendText(res, 200, body, contentType);
  } catch {
    sendText(res, 404, 'Not found.');
  }
}

await ensureStorage();

http.createServer(async (req, res) => {
  const url = new URL(req.url, PUBLIC_BASE_URL);

  if (req.method === 'OPTIONS') {
    return sendText(res, 204, '');
  }

  if (req.method === 'POST' && url.pathname === '/api/bookings') return createBooking(req, res);
  if (req.method === 'GET' && url.pathname === '/api/bookings') return listBookings(req, res);

  const documentMatch = /^\/api\/bookings\/([^/]+)\/document$/.exec(url.pathname);
  if (req.method === 'GET' && documentMatch) return downloadDocument(req, res, documentMatch[1]);

  const statusMatch = /^\/api\/bookings\/([^/]+)\/status$/.exec(url.pathname);
  if (req.method === 'PATCH' && statusMatch) return updateBookingStatus(req, res, statusMatch[1]);

  if (url.pathname === '/admin') return serveFile(res, 'admin.html', 'text/html');
  if (url.pathname === '/' || url.pathname === '/index.html') return serveFile(res, 'index.html', 'text/html');

  return sendText(res, 404, 'Not found.');
}).listen(PORT, '127.0.0.1', () => {
  console.log(`Booking API running at http://127.0.0.1:${PORT}`);
  console.log(`Admin dashboard: http://127.0.0.1:${PORT}/admin`);
});
