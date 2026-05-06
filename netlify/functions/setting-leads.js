// Netlify Function : Setting Hub backend
// GET    /.netlify/functions/setting-leads → liste les leads à setter (optin masterclass sans CALL BOOKED)
// POST   /.netlify/functions/setting-leads → marque un lead comme "SETTING CONTACTED" {contactId}
//
// Auth: header X-Setting-Password ou query param ?p=...

const SYSTEMEIO_API = 'https://api.systeme.io/api';

const TAGS = {
  // Tags qui indiquent un OPTIN (qualifie pour le setting)
  optinTagIds: [
    1721885,  // optin masterclass (nouveau funnel)
    1058797,  // OPTIN
    985110,   // OPTIN VSL ADS
    1345907,  // OPTIN VSL ADS JAN 25
    1054256,  // OPTIN VSL ORGA INSTA
    1057171,  // OPTIN VSL ORGA TT
    1057170,  // OPTIN VSL ORGA YT
  ],
  // Tags qui SORTENT du setting (lead déjà qualifié/disqualifié)
  excludeTagIds: [
    985114,   // CALL CLOSING BOOKED
    1103432,  // CALL BOOKED ZAPIER
    1027337,  // CLOSED ✅
    1022741,  // DESINSCRITS
    1021252,  // SETTING OK - PAS INTERESSE
    1021284,  // CALL CLOSING OK - Lost
    1017358,  // CALL CLOSING OK - To follow
    1016403,  // LEAD BEFORE AUG 24 (trop vieux, ne pas re-contacter)
  ],
  // Pour marquage manuel
  callBooked: 985114,
  settingContacted: 1988671,
};

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

function checkAuth(event) {
  const expected = process.env.SETTING_PASSWORD;
  if (!expected) return false;
  const provided =
    event.headers?.['x-setting-password'] ||
    event.headers?.['X-Setting-Password'] ||
    new URLSearchParams(event.rawQuery || '').get('p') ||
    '';
  return provided === expected;
}

exports.handler = async (event) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Setting-Password',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: cors, body: '' };
  }

  if (!checkAuth(event)) {
    return { statusCode: 401, headers: cors, body: JSON.stringify({ error: 'unauthorized' }) };
  }

  if (event.httpMethod === 'GET') {
    // Récupère contacts (paginé, max 20 pages = 2000 contacts récents)
    const allLeads = [];
    let page = 1;
    const maxPages = 20;
    while (page <= maxPages) {
      const resp = await siApi(`/contacts?limit=100&page=${page}`);
      if (!resp.ok) break;
      const items = resp.data.items || resp.data['hydra:member'] || [];
      if (items.length === 0) break;
      allLeads.push(...items);
      if (items.length < 100) break;
      page++;
    }

    // Filtrer : a au moins un tag d'optin, n'a aucun tag d'exclusion
    const optinSet = new Set(TAGS.optinTagIds);
    const excludeSet = new Set(TAGS.excludeTagIds);
    const leads = allLeads
      .filter(c => {
        const tagIds = (c.tags || []).map(t => t.id);
        const hasOptin = tagIds.some(id => optinSet.has(id));
        const hasExclude = tagIds.some(id => excludeSet.has(id));
        return hasOptin && !hasExclude;
      })
      .map(c => {
        const fields = c.fields || [];
        const firstName = fields.find(f => f.slug === 'first_name')?.value || '';
        const phone = fields.find(f => f.slug === 'phone_number')?.value || '';
        const tagIds = (c.tags || []).map(t => t.id);
        const tagNames = (c.tags || []).map(t => t.name);
        const isContacted = tagIds.includes(TAGS.settingContacted);
        // Detect source from existing tags
        let source = null;
        if (tagIds.includes(1054256)) source = 'insta';
        else if (tagIds.includes(1057171)) source = 'tiktok';
        else if (tagIds.includes(1057170)) source = 'youtube';
        return {
          id: c.id,
          email: c.email,
          firstName,
          phone,
          registeredAt: c.registeredAt,
          source,
          isContacted,
          tags: tagNames,
        };
      })
      // Sort: not yet contacted first, then by oldest
      .sort((a, b) => {
        if (a.isContacted !== b.isContacted) return a.isContacted ? 1 : -1;
        return new Date(a.registeredAt) - new Date(b.registeredAt);
      });

    return {
      statusCode: 200,
      headers: { ...cors, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: true, leads, total: leads.length, totalScanned: allLeads.length }),
    };
  }

  if (event.httpMethod === 'POST') {
    let payload;
    try { payload = JSON.parse(event.body || '{}'); }
    catch { return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'bad_json' }) }; }
    const { contactId, action } = payload;
    if (!contactId) return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'missing_contactId' }) };

    const tagId = action === 'unmark' ? null : TAGS.settingContacted;
    if (action === 'unmark') {
      const r = await siApi(`/contacts/${contactId}/tags/${TAGS.settingContacted}`, 'DELETE');
      return { statusCode: r.ok ? 200 : 422, headers: cors, body: JSON.stringify({ ok: r.ok }) };
    } else {
      const r = await siApi(`/contacts/${contactId}/tags`, 'POST', { tagId: TAGS.settingContacted });
      return { statusCode: r.ok ? 200 : 422, headers: cors, body: JSON.stringify({ ok: r.ok }) };
    }
  }

  return { statusCode: 405, headers: cors, body: JSON.stringify({ error: 'method_not_allowed' }) };
};
