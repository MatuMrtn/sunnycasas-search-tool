'use strict';
require('dotenv').config();

function required(name, fallback) {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === '') {
    if (process.env.GHL_MOCK === '1') return `mock-${name.toLowerCase()}`;
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return v;
}

// Agents: "Name:email:password" entries, comma separated.
// Optional explicit GHL user id as a fourth part: "Name:email:password:GHLUSERID"
// (without it, the app matches the agent to a GHL user by email at runtime).
// An agent without a password falls back to APP_PASSWORD (not recommended for production).
function parseAgents(str) {
  return (str || 'Karl:karl@sunnycasas.com')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .map(s => {
      const [name, email, password, ghlUserId] = s.split(':').map(x => x.trim());
      return { name, email: (email || '').toLowerCase(), password: password || null, ghlUserId: ghlUserId || null };
    });
}

const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  mock: process.env.GHL_MOCK === '1',
  appPassword: required('APP_PASSWORD', process.env.GHL_MOCK === '1' ? 'demo' : undefined),
  cookieSecret: process.env.COOKIE_SECRET || 'change-me-in-production-' + (process.env.APP_PASSWORD || ''),
  agents: parseAgents(process.env.AGENTS),
  dbFile: process.env.DB_FILE || './data/search-engine.db',

  ghl: {
    baseUrl: 'https://services.leadconnectorhq.com',
    version: '2021-07-28',
    token: process.env.GHL_MOCK === '1' ? 'mock' : required('GHL_TOKEN'),
    locationId: process.env.GHL_LOCATION_ID || 'qzYloql6Jcjh98LROmrj',

    // Sunny Casas Sales Pipeline (verified against the live account, June 2026)
    pipelineId: process.env.GHL_PIPELINE_ID || '0tHY10mlnit6NiS80OLF',
    stages: {
      activeSearch: process.env.GHL_STAGE_ACTIVE || '2d72ecff-cd9a-4443-a466-f43f5e82dcb8',   // Active Property Search
      longTermSearch: process.env.GHL_STAGE_LONGTERM || '9e7b589a-ff0c-4a1a-a4c0-b73203034282', // Long-Term Property Search
      awaitingFeedback: process.env.GHL_STAGE_AWAITING || 'a4a7b922-b50b-45c6-9bcc-faeac0b2e463' // Awaiting Feedback
    },

    // Existing opportunity custom fields, resolved by fieldKey at boot (IDs as fallback)
    criteriaFieldKeys: {
      budgetMin: 'opportunity.verified_budget_min',
      budgetMax: 'opportunity.verified_budget_max',
      areas: 'opportunity.areas',
      minBeds: 'opportunity.min_beds',
      minBaths: 'opportunity.min_bathrooms',
      propertyStatus: 'opportunity.property_status_wanted',
      timeline: 'opportunity.buyingselling_timeline',
      clientArriving: 'opportunity.client_arrival',
      clientLeaving: 'opportunity.client_leaving',
      contactMethod: 'opportunity.preferred_contact_method',
      leadTemperature: 'opportunity.lead_temperature',
      priorityScore: 'opportunity.priority_score',
      propertyReference: 'opportunity.property_reference'
    },

    // Fields the app creates on first run if missing (model: opportunity)
    managedFields: [
      { name: 'SE Last Search Date', key: 'opportunity.se_last_search_date', dataType: 'TEXT' },
      { name: 'SE Search Round', key: 'opportunity.se_search_round', dataType: 'NUMERICAL' },
      { name: 'SE Portals Covered', key: 'opportunity.se_portals_covered', dataType: 'TEXT' },
      { name: 'SE Shortlist Link', key: 'opportunity.se_shortlist_link', dataType: 'TEXT' },
      { name: 'SE Search Feedback', key: 'opportunity.se_search_feedback', dataType: 'LARGE_TEXT' }
    ],

    followUpDays: parseInt(process.env.FOLLOW_UP_DAYS || '3', 10),
    autoStageMove: process.env.AUTO_STAGE_MOVE !== '0', // default on
    // Also show opportunities with no assigned owner (tagged "Unassigned") — default off
    showUnassigned: process.env.SHOW_UNASSIGNED === '1'
  },

  // Portal walk order. {minPrice} {maxPrice} {beds} {q} placeholders are filled per client.
  portals: [
    { name: 'SunnyCasas.com', note: 'Own stock first — Inmovilla-synced listings.',
      url: 'https://sunnycasas.com/en/properties?minPrice={minPrice}&maxPrice={maxPrice}&minBedrooms={beds}', minutes: 4 },
    { name: 'Inmovilla', note: 'Open demand matching for the linked Inmovilla customer.',
      url: 'https://www.inmovilla.com/', minutes: 5 },
    { name: 'Idealista', note: 'Filter by price, zone and beds — criteria pinned on the left.',
      url: 'https://www.idealista.com/en/venta-viviendas/', minutes: 5 },
    { name: 'Fotocasa', note: 'Filter by price band and municipality.',
      url: 'https://www.fotocasa.es/en/', minutes: 4 },
    { name: 'Kyero', note: 'International portal — strong for NW-European buyers.',
      url: 'https://www.kyero.com/en', minutes: 4 },
    { name: 'ThinkSpain', note: 'Check listings added since the last round.',
      url: 'https://www.thinkspain.com/property-for-sale', minutes: 3 },
    { name: 'Habitaclia', note: 'Secondary coverage — quick pass.',
      url: 'https://www.habitaclia.com/', minutes: 2 },
    { name: 'Pisos.com', note: 'Secondary coverage — quick pass.',
      url: 'https://www.pisos.com/', minutes: 2 },
    { name: 'Collaborator network', note: 'Shared MLS and collaborating agency stock.',
      url: '', minutes: 4 }
  ]
};

module.exports = config;
