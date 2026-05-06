// Netlify Function : reçoit webhook Cal.com BOOKING_CREATED, ajoute tag "CALL CLOSING BOOKED" au contact
// Endpoint: /.netlify/functions/cal-webhook
// Cal.com sends POST with attendee email, etc.

const SYSTEMEIO_API = 'https://api.systeme.io/api';

const TAG_CALL_BOOKED = 985114; // "CALL CLOSING BOOKED" - tag existant Marwan
const TAG_SOURCE = {
  insta:    1054256,  // "OPTIN VSL ORGA INSTA"
  tiktok:   1057171,  // "OPTIN VSL ORGA TT"
  youtube:  1057170,  // "OPTIN VSL ORGA YT"
};

function detectSource(text) {
  if (!text) return null;
  const s = String(text).toLowerCase();
  if (s.includes('insta')) return 'insta';
  if (s.includes('tiktok') || s.includes('tik-tok') || s === 'tt') return 'tiktok';
  if (s.includes('youtube') || s.includes('you tube') || s === 'yt') return 'youtube';
  return null;
}

function extractDiscoverySource(payload) {
  // Cal.com responses can be in: payload.responses or payload.customInputs (legacy) or in attendee.responses
  const candidates = [
    payload?.responses,
    payload?.customInputs,
    payload?.attendees?.[0]?.responses,
    payload?.bookingFieldsResponses,
  ];
  for (const c of candidates) {
    if (!c) continue;
    // Possible keys for the discovery question
    for (const key of ['discovery_source', 'source', 'comment-tu-mas-decouvert', 'comment_tu_mas_decouvert', 'how_did_you_find_us', 'reseau_social']) {
      const v = c[key];
      if (v) {
        // Cal sometimes wraps as { value: "...", label: "..." }
        const text = typeof v === 'string' ? v : (v.value || v.label || '');
        const detected = detectSource(text);
        if (detected) return detected;
      }
    }
    // Fallback: scan all responses for a value matching insta/tiktok/youtube
    for (const v of Object.values(c)) {
      const text = typeof v === 'string' ? v : (v?.value || v?.label || '');
      const detected = detectSource(text);
      if (detected) return detected;
    }
  }
  return null;
}

async function siApi(path, method = 'GET', body = null) {
  const url = `${SYSTEMEIO_API}${path}`;
  const opts = {
    method,
    headers: {
      'X-API-Key': process.env.SYSTEMEIO_API_KEY,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
  };
  if (body) opts.body = JSON.stringify(body);
  const resp = await fetch(url, opts);
  const text = await resp.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  return { status: resp.status, ok: resp.ok, data };
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'method not allowed' };
  }

  let payload;
  try { payload = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, body: 'bad json' }; }

  // Cal.com BOOKING_CREATED format: { triggerEvent, payload: { attendees: [{email, name}], ... } }
  const event_type = payload.triggerEvent || payload.event;
  if (event_type && event_type !== 'BOOKING_CREATED' && event_type !== 'booking.created') {
    return { statusCode: 200, body: JSON.stringify({ ignored: event_type }) };
  }

  const data = payload.payload || payload;
  const attendees = data.attendees || data.attendee || [];
  const firstAttendee = Array.isArray(attendees) ? attendees[0] : attendees;
  const email = firstAttendee?.email;

  if (!email) {
    return { statusCode: 400, body: JSON.stringify({ error: 'no_email_in_webhook', payload }) };
  }

  // 1. Cherche le contact
  const search = await siApi(`/contacts?email=${encodeURIComponent(email)}`);
  let contact = null;
  if (search.ok) {
    const items = search.data.items || search.data['hydra:member'] || [];
    if (items.length > 0) contact = items[0];
  }

  // 2. Si contact n'existe pas, le créer
  if (!contact) {
    const name = firstAttendee?.name || '';
    const firstName = name.split(' ')[0] || 'Lead';
    const fields = [{ slug: 'first_name', value: firstName }];
    const create = await siApi('/contacts', 'POST', { email, fields });
    if (create.ok) contact = create.data;
  }

  if (!contact?.id) {
    return { statusCode: 422, body: JSON.stringify({ error: 'contact_unavailable', email }) };
  }

  // 3. Ajouter tag "CALL CLOSING BOOKED"
  const tagsAdded = ['CALL CLOSING BOOKED'];
  await siApi(`/contacts/${contact.id}/tags`, 'POST', { tagId: TAG_CALL_BOOKED });

  // 4. Si source détectée dans les réponses Cal, ajouter le tag source correspondant
  const detectedSource = extractDiscoverySource(data);
  if (detectedSource && TAG_SOURCE[detectedSource]) {
    await siApi(`/contacts/${contact.id}/tags`, 'POST', { tagId: TAG_SOURCE[detectedSource] });
    tagsAdded.push(`source:${detectedSource}`);
  }

  return {
    statusCode: 200,
    body: JSON.stringify({ ok: true, contactId: contact.id, taggedAs: tagsAdded, source: detectedSource }),
  };
};
