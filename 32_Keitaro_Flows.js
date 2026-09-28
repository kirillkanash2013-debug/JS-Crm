/**
 * Read-only Keitaro campaign/flow inventory for the Telegram control panel.
 * Mutations are added only after the live stream schema has been verified.
 */
function getKeitaroCampaignStreams_(campaignId) {
  const id = String(campaignId || '').trim();
  if (!/^\d+$/.test(id)) throw new Error('Некорректный Campaign ID');
  const raw = keitaroGet_('campaigns/' + id + '/streams');
  if (Array.isArray(raw)) return raw;
  if (raw && Array.isArray(raw.data)) return raw.data;
  if (raw && Array.isArray(raw.streams)) return raw.streams;
  return [];
}

function getKeitaroStreamOffers_(stream) {
  const schema = stream && (stream.schema || stream.action_payload || stream.payload) || {};
  const candidates = [
    stream && stream.offers,
    schema.offers,
    schema.offer_list,
    stream && stream.offer_list
  ];
  for (let i = 0; i < candidates.length; i++) {
    if (Array.isArray(candidates[i])) return candidates[i];
  }
  return [];
}

function normalizeKeitaroStream_(stream) {
  const offers = getKeitaroStreamOffers_(stream).map(function (offer) {
    return {
      id: String(pick_(offer, ['offer_id', 'id']) || ''),
      name: getDimensionLabel_(pick_(offer, ['offer', 'name', 'title'])),
      weight: num_(pick_(offer, ['share', 'weight', 'percent', 'ratio']))
    };
  });
  return {
    id: String(pick_(stream, ['id', 'stream_id']) || ''),
    name: String(pick_(stream, ['name', 'title']) || 'Без названия'),
    status: String(pick_(stream, ['state', 'status']) || 'UNKNOWN').toUpperCase(),
    type: String(pick_(stream, ['type', 'stream_type']) || ''),
    position: pick_(stream, ['position', 'priority']),
    offers: offers,
    raw: stream
  };
}

function getCampaignFlowView_(campaignId) {
  return getKeitaroCampaignStreams_(campaignId).map(normalizeKeitaroStream_);
}
