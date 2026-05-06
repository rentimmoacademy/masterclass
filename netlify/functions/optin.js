// Netlify Function : reçoit submit du form optin, crée contact + ajoute tags dans Systeme.io
// Endpoint: /.netlify/functions/optin
// POST body: { firstName, email, phone?, source }

const SYSTEMEIO_API = 'https://api.systeme.io/api';

// Tag IDs récupérés depuis l'API au préalable
const TAGS = {
  optinMasterclass: 1721885,         // "optin masterclass"
  sourceInsta: 1054256,              // "OPTIN VSL ORGA INSTA"
  sourceTiktok: 1057171,             // "OPTIN VSL ORGA TT"
  sourceYoutube: 1057170,            // "OPTIN VSL ORGA YT"
};

// Source tagging optionnel : seulement si query param ?src=... explicite
function getSourceTagId(source) {
  if (!source) return null;
  const s = source.toLowerCase();
  if (s.startsWith('tt') || s.includes('tiktok')) return TAGS.sourceTiktok;
  if (s.startsWith('yt') || s.includes('youtube')) return TAGS.sourceYoutube;
  if (s.startsWith('ig') || s.includes('insta')) return TAGS.sourceInsta;
  return null; // source inconnue → pas de tag source
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
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: cors, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: cors, body: JSON.stringify({ error: 'method_not_allowed' }) };
  }

  let payload;
  try { payload = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'bad_json' }) }; }

  const { firstName, email, phone, source } = payload;
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'invalid_email' }) };
  }
  if (!firstName || firstName.length < 1) {
    return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'missing_first_name' }) };
  }

  // 1. Cherche si le contact existe déjà
  let contact = null;
  const search = await siApi(`/contacts?email=${encodeURIComponent(email)}`);
  if (search.ok) {
    const items = search.data.items || search.data['hydra:member'] || [];
    if (items.length > 0) contact = items[0];
  }

  // 2. Créer le contact si absent
  if (!contact) {
    const fields = [{ slug: 'first_name', value: firstName }];
    if (phone) fields.push({ slug: 'phone_number', value: phone });
    const create = await siApi('/contacts', 'POST', { email, fields });
    if (!create.ok) {
      // Detect specific Systeme.io email validation rejection
      const detail = JSON.stringify(create.data || '');
      const emailInvalid = /n'existe pas|invalide|MX|enregistrement DNS/i.test(detail);
      return {
        statusCode: emailInvalid ? 400 : 422,
        headers: cors,
        body: JSON.stringify({
          error: emailInvalid ? 'email_not_deliverable' : 'create_contact_failed',
          message: emailInvalid
            ? "Cette adresse email ne semble pas valide. Vérifie ton email et réessaie."
            : "Une erreur technique est survenue. Réessaie dans une minute.",
        }),
      };
    }
    contact = create.data;
  }

  const contactId = contact.id;

  // 3. Ajouter les tags (optin masterclass + source si connue)
  const tagsToAdd = [TAGS.optinMasterclass];
  const sourceTagId = getSourceTagId(source);
  if (sourceTagId) tagsToAdd.push(sourceTagId);
  for (const tagId of tagsToAdd) {
    await siApi(`/contacts/${contactId}/tags`, 'POST', { tagId });
  }

  return {
    statusCode: 200,
    headers: cors,
    body: JSON.stringify({ ok: true, contactId, redirect: '/masterclass.html' }),
  };
};
