/**
 * Connectors: what an agent is ALLOWED to reach.
 *
 * Distinct from rigs, which decide what it can DO. A Salvaged Terminal with a
 * Gmail pass can read your mail but not build a PDF; an Overclocked Rig with
 * no passes can build anything but sees none of your accounts.
 *
 * An account is linked once at the world level, then granted per agent. That
 * keeps least privilege a visible decision rather than an implicit one.
 *
 * This file is the only place a connector is described. Everything else -
 * consent, token storage, the pass cards, which tools an agent gets - reads
 * these entries and has no idea which vendor it is dealing with.
 *
 * `provider` names the OAuth app in the AgentCore token vault, and is one per
 * VENDOR, not one per product: the vault keys credentials by scope, so Gmail
 * and Calendar share a Google app and still get separate consent and separate
 * tokens. (Its name is historical - it was created when Gmail was the only
 * connector - so it is set in one place here rather than spelled out four
 * times.)
 */
const GOOGLE = process.env.GOOGLE_PROVIDER_NAME || process.env.GMAIL_PROVIDER_NAME || '';

/**
 * Google issues a refresh token only when asked for offline access, and will
 * skip the consent screen for a grant it believes it has already made - which
 * returns a code carrying nothing new. A vault that has to keep a credential
 * alive for weeks needs both.
 */
const GOOGLE_AUTH_PARAMS = { access_type: 'offline', prompt: 'consent' };

export const CONNECTORS = {
  gmail: {
    id: 'gmail',
    label: 'Gmail',
    blurb: 'Read your inbox and leave drafts for you to send.',
    vendor: 'GoogleOauth2',
    provider: GOOGLE,
    authParams: GOOGLE_AUTH_PARAMS,
    scopes: [
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/gmail.compose',
    ],
    /** Shown on the pass so the grant is explicit about what it allows. */
    allows: ['search your mail', 'read a message', 'leave a draft'],
    badge: '#e0574f',
    available: true,
  },
  calendar: {
    id: 'calendar',
    label: 'Calendar',
    blurb: 'See your schedule, find free slots, and put things in the diary.',
    vendor: 'GoogleOauth2',
    provider: GOOGLE,
    authParams: GOOGLE_AUTH_PARAMS,
    // events + readonly rather than blanket `calendar`: the same features,
    // without the power to delete whole calendars or change who they are
    // shared with.
    scopes: [
      'https://www.googleapis.com/auth/calendar.events',
      'https://www.googleapis.com/auth/calendar.readonly',
    ],
    allows: ['read your events', 'find free time', 'add and change events'],
    badge: '#4285f4',
    available: true,
  },
  slack: {
    id: 'slack', label: 'Slack', blurb: 'Read channels and post messages.',
    vendor: 'SlackOauth2', provider: process.env.SLACK_PROVIDER_NAME || '',
    scopes: ['channels:history', 'chat:write'],
    allows: ['read channels', 'post a message'], badge: '#611f69', available: false,
  },
  notion: {
    id: 'notion', label: 'Notion', blurb: 'Read and write pages in your workspace.',
    vendor: 'NotionOauth2', provider: process.env.NOTION_PROVIDER_NAME || '',
    scopes: [],
    allows: ['read pages', 'write pages'], badge: '#c9c5ae', available: false,
  },
};

export const connectorFor = (id) => CONNECTORS[id] ?? null;
export const availableConnectors = () => Object.values(CONNECTORS).filter((c) => c.available);

/**
 * A connector with no provider configured runs off its stub. That is the demo
 * path, and it is per connector: real Gmail alongside a fake calendar is a
 * perfectly good state to be in halfway through wiring one up.
 */
export const isMock = (id) => !CONNECTORS[id]?.provider;

/** True when every available connector is running off a stub. */
export const allMock = () => availableConnectors().every((c) => isMock(c.id));

/** What the Foundry needs to draw the shop. */
export const connectorCatalogue = () =>
  Object.values(CONNECTORS).map(({ id, label, blurb, allows, badge, available }) => ({
    id, label, blurb, allows, badge, available, mock: isMock(id),
  }));
