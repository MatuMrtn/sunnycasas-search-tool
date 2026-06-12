'use strict';
/** Mock GHL data so the app runs end-to-end without a token (GHL_MOCK=1). */
const recorded = [];

const mockUsers = [
  { id: 'user-karl', name: 'Karl', email: 'karl@sunnycasas.com' },
  { id: 'user-anna', name: 'Anna', email: 'anna@sunnycasas.com' }
];

const sampleOpps = (stageId) => {
  const active = stageId === '2d72ecff-cd9a-4443-a466-f43f5e82dcb8';
  if (!active) {
    return [{
      id: 'opp-lindqvist', contactId: 'ct-lindqvist', name: 'Sven Lindqvist', assignedTo: null,
      customFields: [
        { id: 'f-bmin', fieldValue: '120000' }, { id: 'f-bmax', fieldValue: '160000' },
        { id: 'f-areas', fieldValue: 'Torrevieja' }, { id: 'f-temp', fieldValue: 'Cold' },
        { id: 'f-round', fieldValue: '1' }
      ]
    }];
  }
  return [
    {
      id: 'opp-dubois', contactId: 'ct-dubois', name: 'Famille Dubois', assignedTo: 'user-karl',
      customFields: [
        { id: 'f-bmin', fieldValue: '250000' }, { id: 'f-bmax', fieldValue: '320000' },
        { id: 'f-areas', fieldValue: 'Villamartín, Playa Flamenca' },
        { id: 'f-beds', fieldValue: '2' }, { id: 'f-baths', fieldValue: '2' },
        { id: 'f-status', fieldValue: 'Resales' }, { id: 'f-arrive', fieldValue: '2026-06-28' },
        { id: 'f-contact', fieldValue: 'Whatsapp' }, { id: 'f-temp', fieldValue: 'Hot' },
        { id: 'f-prio', fieldValue: '90' }, { id: 'f-lastsearch', fieldValue: '2026-06-10T08:00:00.000Z' },
        { id: 'f-round', fieldValue: '2' },
        { id: 'f-feedback', fieldValue: 'Round 2: 4 properties sent, all declined — too far from the beach. Prioritise walking distance under 15 min.' }
      ]
    },
    {
      id: 'opp-janssens', contactId: 'ct-janssens', name: 'The Janssens', assignedTo: 'user-karl',
      customFields: [
        { id: 'f-bmin', fieldValue: '180000' }, { id: 'f-bmax', fieldValue: '230000' },
        { id: 'f-areas', fieldValue: 'Torrevieja centre' }, { id: 'f-beds', fieldValue: '2' },
        { id: 'f-timeline', fieldValue: '0-3 Months' }, { id: 'f-temp', fieldValue: 'Warm' },
        { id: 'f-prio', fieldValue: '60' }, { id: 'f-lastsearch', fieldValue: '2026-06-11T05:00:00.000Z' },
        { id: 'f-round', fieldValue: '1' }
      ]
    },
    {
      id: 'opp-muller', contactId: 'ct-muller', name: 'Herr & Frau Müller', assignedTo: 'user-anna',
      customFields: [
        { id: 'f-bmin', fieldValue: '400000' }, { id: 'f-bmax', fieldValue: '550000' },
        { id: 'f-areas', fieldValue: 'Cabo Roig, La Zenia' }, { id: 'f-beds', fieldValue: '3' },
        { id: 'f-temp', fieldValue: 'Warm' }, { id: 'f-prio', fieldValue: '70' },
        { id: 'f-lastsearch', fieldValue: '2026-06-12T06:00:00.000Z' }, { id: 'f-round', fieldValue: '0' }
      ]
    }
  ];
};

const mockFields = [
  ['opportunity.verified_budget_min', 'f-bmin'], ['opportunity.verified_budget_max', 'f-bmax'],
  ['opportunity.areas', 'f-areas'], ['opportunity.min_beds', 'f-beds'],
  ['opportunity.min_bathrooms', 'f-baths'], ['opportunity.property_status_wanted', 'f-status'],
  ['opportunity.buyingselling_timeline', 'f-timeline'], ['opportunity.client_arrival', 'f-arrive'],
  ['opportunity.client_leaving', 'f-leave'], ['opportunity.preferred_contact_method', 'f-contact'],
  ['opportunity.lead_temperature', 'f-temp'], ['opportunity.priority_score', 'f-prio'],
  ['opportunity.property_reference', 'f-ref'],
  ['opportunity.se_last_search_date', 'f-lastsearch'], ['opportunity.se_search_round', 'f-round'],
  ['opportunity.se_portals_covered', 'f-covered'], ['opportunity.se_shortlist_link', 'f-shortlist'],
  ['opportunity.se_search_feedback', 'f-feedback']
];

module.exports = {
  loadFields(cache) {
    cache.byKey.clear(); cache.byId.clear();
    for (const [key, id] of mockFields) {
      const f = { id, fieldKey: key, name: key.split('.')[1], model: 'opportunity' };
      cache.byKey.set(key, f); cache.byId.set(id, f);
    }
    cache.fetchedAt = Date.now();
    return cache;
  },
  searchStage(stageId) { return sampleOpps(stageId); },
  getUsers() { return mockUsers; },
  record(type, payload) {
    recorded.push({ type, payload, at: new Date().toISOString() });
    console.log(`[mock GHL] ${type}:`, JSON.stringify(payload).slice(0, 300));
    return { mock: true };
  },
  recorded
};
