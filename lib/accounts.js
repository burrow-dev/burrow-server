"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const {DatabaseSync, backup: copyDatabase} = require("node:sqlite");
const config = require("../config.js");
const defpacks = require("./defpacks.js");
const names = require("./names.js");

// accounts live in a SQLite database. identity and credentials are columns;
// everything a player owns (animals, items, pets, den, buddies, ...) is one
// JSON document per account in `state`.
//
// every account is held in memory while the server runs. game code changes
// those objects directly and then calls save(account, ...), which has the
// accounts named written back a moment later, and the others looked at a
// few at a time (flush, below).

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS accounts (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT NOT NULL,
    username_key  TEXT NOT NULL UNIQUE,
    password_salt TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    created_at    INTEGER NOT NULL,
    state         TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS retired_names (
    name_key TEXT PRIMARY KEY,
    until    INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS tokens (
    token      TEXT PRIMARY KEY,
    account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL
  );
`;

// fields stored in their own columns rather than in `state`.
const COLUMN_FIELDS = ["id", "username", "salt", "hash", "createdAt"];
// how the game treats the account this session; set again at every login.
const SESSION_FIELDS = ["accountType", "isGuide", "isModerator", "membershipDays", "startInDen", "startRoom"];
const DEFAULT_MEMBERSHIP_DAYS = 9999;
const MAX_ACCOUNT_TYPE = 5;
const MEMBERSHIP_TYPES = [0, 2]; // non-member, member
const MAX_MEMBERSHIP_DAYS = 99999;

const USERNAME_PATTERN = /^[A-Za-z0-9 .-]{3,20}$/;
const MIN_LETTERS = 3; // the client's own rule (SbiConstants.USERNAME_REGEX)
const MIN_PASSWORD_LENGTH = 10;
const MAX_DEN_SLOTS = 200; // DenSwitch.nextFreeSlotIdx
const DEN_OPEN = 2; // den privacy: 0 locked, 1 buddies only, 2 everyone
const USER_VAR_SETTINGS = 363; // the settings menu's switches, a bit each (gui.MySettings)
// the chat filter an account starts with: level 1 slurs and threats, mode 1
// the whole message left out (see account.filter below).
const DEFAULT_FILTER = {level: 1, mode: 1, words: ""};
const MAX_PASSWORD_LENGTH = 100;
// parts of the game a player can switch off for their own account, each
// enforced where the game asks for it (featureOn below).
// the Early Member badge (lib/badges.js) goes to an account made while
// there are no more than this many.
const EARLY_MEMBERS = 100;
const EARLY_BADGE = "early";
const EARLY_SETTING = "earlyMembersGiven";

const FEATURES = ["chat", "buddies", "trading", "jamagrams", "gameInvites", "wall"];
const MAX_LOGINS_KEPT = 40;
const LOGIN_DAYS_KEPT = 90; // and none older than this: they hold addresses

let db = null;
const byKey = new Map(); // lowercased username -> account
const byId = new Map();
const savedState = new Map(); // account id -> state JSON as last written
// A name somebody gave up (a rename, a deleted account) is nobody's to take
// for a while: whoever had it is still known by it to the players they met.
const NAME_HELD_DAYS = 30;
const retired = new Map(); // lowercased username -> until (seconds)
const tokens = new Map(); // SHA-256 of a login token -> {id, createdAt}

// tokens are as good as passwords, so only their hashes are stored.
const TOKEN_HEX_LENGTH = 48;
const MAX_TOKENS_PER_ACCOUNT = 10;
const tokenHash = token => crypto.createHash("sha256").update(token).digest("hex");
const tokenExpired = createdAt => now() - createdAt > config.tokenLifetimeDays * 86400;

const now = () => Math.floor(Date.now() / 1000);

const hashPassword = (password, salt) => crypto.scryptSync(password, salt, 32).toString("hex");
// the same off the main thread, for the sign-ins strangers can repeat: a
// password check takes long enough that a row of them would hold the game up.
const hashPasswordAsync = (password, salt) => new Promise((resolve, reject) => {
  crypto.scrypt(password, salt, 32, (err, hash) => (err ? reject(err) : resolve(hash.toString("hex"))));
});
// checked against when the name is nobody's, so that a wrong name takes as
// long to refuse as a wrong password.
const NOBODY_SALT = crypto.randomBytes(16).toString("hex");

// eyes and pattern an animal type starts with. custom ("special") animals
// carry their own pattern.
const newAvatar = (ids, name, type, customAvId) => {
  const def = defpacks.avatarDef(type);
  const custom = defpacks.customAvatarDef(customAvId);
  return {
    ...ids,
    name,
    type: Number(type),
    customAvId: custom ? Number(customAvId) : -1,
    colors: [def.colorLayer1, Number(custom && custom.overrideColorLayer2) || def.colorLayer2, def.colorLayer3].map(Number),
    eyes: Number(def.baseEyesId) || 0,
    pattern: Number(custom ? defpacks.customPattern(customAvId) : def.basePatternId) || 0,
    petInvId: 0,
  };
};

// an animal's inventory id is a bit's place in what the client keeps for
// every piece of clothing, "which of my animals wear this"
// (item.EquippedAvatars): 32 words of 32 bits and no more, and a bit past
// them is an error that ends the login. so it is a slot, 1 to 1000, and
// never a number from the item counter.
const MAX_AVATAR_SLOT = 1000;
const freeAvatarSlot = account => {
  const taken = new Set(account.avatars.map(avatar => avatar.avInvId));
  let slot = 1;
  while (taken.has(slot)) {
    slot++;
  }
  return slot;
};

// brings accounts saved by older versions up to the current shape.
const normalize = account => {
  if (!account.avatars) {
    const old = account.avatar;
    account.avatars = [{...newAvatar({perUserAvId: old.perUserAvId, avInvId: old.avInvId}, old.name, old.type, old.customAvId), colors: old.colors}];
    account.activeAvatar = old.perUserAvId;
    delete account.avatar;
  }
  account.currency = account.currency || {};
  account.items = account.items || []; // {inv, def, color, on: [avInvId, ...]}
  // animals made before their inventory ids were slots (above) have ids
  // from the item counter: they move into free slots, and what their
  // clothes say about who wears them follows.
  for (const avatar of account.avatars.filter(candidate => !(candidate.avInvId >= 1 && candidate.avInvId <= MAX_AVATAR_SLOT))) {
    const old = avatar.avInvId;
    avatar.avInvId = 0; // out of the way while a slot is looked for
    avatar.avInvId = freeAvatarSlot(account);
    for (const item of account.items) {
      item.on = (item.on || []).map(avInvId => (avInvId === old ? avatar.avInvId : avInvId));
    }
    if (account.outfitUndo && account.outfitUndo.avInvId === old) {
      account.outfitUndo.avInvId = avatar.avInvId;
    }
  }
  // custom animals made while their pattern list was a 0 (lib/defpacks.js)
  for (const avatar of account.avatars.filter(candidate => candidate.customAvId !== -1 && !candidate.pattern)) {
    avatar.pattern = defpacks.customPattern(avatar.customAvId);
  }
  account.pets = account.pets || []; // {inv, lBits, uBits, eBits, name, createdAt}
  account.dens = account.dens || [{inv: 0, def: config.denDefId}]; // den rooms owned
  account.activeDen = account.activeDen || 0; // inv of the den in use
  // A den's id is its slot on the den switcher, 0 to 199 (lib/dens.js). dens
  // bought before that was known have ids from the item counter: they move
  // into the first free slots, and what points at them follows.
  if (account.dens.some(den => den.inv >= MAX_DEN_SLOTS)) {
    const taken = new Set(account.dens.map(den => den.inv).filter(inv => inv < MAX_DEN_SLOTS));
    const moved = new Map();
    for (const den of account.dens.filter(candidate => candidate.inv >= MAX_DEN_SLOTS)) {
      let slot = 0;
      while (taken.has(slot)) {
        slot++;
      }
      taken.add(slot);
      moved.set(den.inv, slot);
      den.inv = slot;
    }
    account.activeDen = moved.has(account.activeDen) ? moved.get(account.activeDen) : account.activeDen;
    for (const item of account.denItems || []) {
      item.den = moved.has(item.den) ? moved.get(item.den) : item.den;
      if (item.spots) {
        item.spots = Object.fromEntries(Object.entries(item.spots).map(([den, spot]) => [moved.has(Number(den)) ? moved.get(Number(den)) : den, spot]));
      }
    }
  }
  account.denPrivacy = account.denPrivacy === undefined ? DEN_OPEN : account.denPrivacy;
  // {inv, def, version, spots, mannequin?, image?}: lib/dens.js. spots: where
  // it stands, {den inventory id: {cat, x, y, flip}}, as many dens as it is in.
  // flip includes the den editor's lock and stack-rank bits (lib/dens.js).
  account.denItems = account.denItems || [];
  for (const item of account.denItems) {
    // from when an item stood in one den at most: {placed, den, x, y, flip, cat}.
    if (!item.spots) {
      const den = item.den === undefined ? account.activeDen : item.den;
      item.spots = item.placed ? {[den]: {cat: item.cat || 1, x: item.x || 0, y: item.y || 0, flip: item.flip || 0}} : {};
    }
    for (const old of ["placed", "den", "x", "y", "flip", "cat"]) {
      delete item[old];
    }
  }
  account.userVars = account.userVars || {};
  // the settings menu's switches (user var 363) were once stored as the
  // number of the last switch touched rather than as bits: such a value
  // cannot be told from a real one, so every account starts again from the
  // game's defaults, once.
  if (!account.settingsBitsFixed) {
    delete account.userVars[USER_VAR_SETTINGS];
    account.settingsBitsFixed = true;
  }
  account.theme = account.theme || ""; // seasonal look of the lands, see themes in config.js
  account.lastSeen = account.lastSeen || 0; // when they last left the game, in seconds; 0 = never recorded
  // what the player set on the account page (lib/manage.js).
  account.features = {...Object.fromEntries(FEATURES.map(name => [name, true])), ...account.features}; // false = switched off
  account.locked = account.locked === true; // nobody gets into the game until its owner unlocks it
  account.logins = account.logins || []; // {at, via, address, ok}, newest first: lib/accounts.js recordLogin
  account.roomThemes = account.roomThemes || {}; // room -> theme, for rooms given a look of their own ("!theme here")
  account.randomTheme = account.randomTheme === true; // a theme picked afresh at every login
  account.denVisits = account.denVisits || []; // {at, name}, newest first: who came into their den
  account.buddyNotes = account.buddyNotes || {}; // lowercased username -> the player's own note about that buddy
  account.tradeHistory = account.tradeHistory || []; // {at, with, got: [names], gave: [names]}, newest first
  account.outfitUndo = account.outfitUndo || null; // {avInvId, items: [inv]}: what an animal wore before its last change
  account.denNames = account.denNames || {}; // den inv -> a name of the player's own ("!den name")
  account.finderGiven = account.finderGiven || {}; // "kind:id" -> {count, at}: what they took from the item finder
  account.tradeOffers = account.tradeOffers || []; // offers left for this account while its owner was away: lib/trades.js
  account.denUndo = account.denUndo || null; // the den as it stood before it was last cleared: {den, items}
  account.buddies = account.buddies || []; // lowercased usernames
  account.blocked = account.blocked || [];
  account.buddyRequests = account.buddyRequests || []; // lowercased usernames of who asked, see lib/buddies.js
  account.tradeList = account.tradeList || []; // {type, inv}; types as in TradeItem
  account.achievements = account.achievements || []; // {inv, def}, see lib/achievements.js
  account.adoptAPets = account.adoptAPets || []; // {inv, def, ts, seen}, see lib/adopt.js
  account.ecards = account.ecards || []; // the Jam-A-Gram inbox, see lib/ecards.js
  account.ecardPrivacy = account.ecardPrivacy || 0; // 0 everyone, 1 buddies only, 2 nobody
  // the Jammer Wall, see lib/walls.js. privacy: 0 nobody, 1 buddies only, 2 everyone.
  account.wall = account.wall || {privacy: DEN_OPEN, posts: [], params: {bg: "19"}, visits: 0, hidden: [], modified: 0, readAt: 0};
  account.outfits = account.outfits || []; // {name, items: [inv, ...]}, see lib/commands.js
  account.denLayouts = account.denLayouts || []; // {name, den, items: [{def, version, x, y, flip}]}
  account.hideBlocked = account.hideBlocked === true; // do not show me players I blocked
  // the name tag: colour in the low byte, badge above it, bit 16 hides the
  // adventure level shape (avatar.NameBar.setColorAndBadge).
  account.nameBarData = Number.isInteger(account.nameBarData) ? account.nameBarData : 0;
  account.disguise = Number.isInteger(account.disguise) ? account.disguise : 0; // NPC id, see lib/disguises.js
  // shown on the player's card: lib/badges.js.
  account.discord = typeof account.discord === "string" ? account.discord : ""; // their Discord username, as they gave it
  account.badges = Array.isArray(account.badges) ? account.badges : []; // badge ids, given in the admin panel
  account.bio = typeof account.bio === "string" ? account.bio : ""; // their own words, for the card's Bio tab
  // seconds spent in the game in all (lib/world.js counts it), and whether
  // their card shows it to others: theirs to choose on the account page.
  account.playtime = Number.isFinite(account.playtime) && account.playtime > 0 ? Math.floor(account.playtime) : 0;
  account.playtimePublic = account.playtimePublic === true;
  // the chat filter, which the player's own game applies (AJClient in the
  // patched SWF; "xfl" in lib/world.js): {level: 1 slurs and threats, 2
  // swearing too, 0 off; mode: 0 stars over the words, 1 the message left
  // out; words: their own, commas between; chosen: have they been asked}.
  // an account starts with slurs and threats hidden, and may turn it off.
  account.filter = account.filter && typeof account.filter === "object" && account.filter.chosen ? account.filter : {...DEFAULT_FILTER, chosen: false};
  // that default came after accounts that had none, or had turned it off:
  // they get it too, once. a stricter level, and the way it is shown when
  // they had one, stay as they were.
  if (!account.filterDefaultApplied) {
    if (!(account.filter.level >= DEFAULT_FILTER.level)) {
      Object.assign(account.filter, {level: DEFAULT_FILTER.level, mode: DEFAULT_FILTER.mode});
    }
    account.filterDefaultApplied = true;
  }
  // two-step sign-in: lib/totp.js.
  account.totp = account.totp || null;
  account.totpSetup = account.totpSetup || null;
  account.devices = Array.isArray(account.devices) ? account.devices : [];
  // the computers it signed in from, keyed (lib/devices.js): [{kind, id, first, last}].
  account.hwids = Array.isArray(account.hwids) ? account.hwids : [];
  account.nextInv = account.nextInv || 2;
  account.numLogins = account.numLogins || 0;
  account.uuid = account.uuid || crypto.randomUUID();
  setLoginChoices(account, null);
  return account;
};

// sets how the game treats the account for the coming session. `choices` is
// what the client asked for at login ({accountType, isGuide, isModerator,
// membershipDays}, each optional); anything missing, invalid or not allowed
// by config.loginChoices gets the usual value.
const MAX_START_ROOM = 80;

function setLoginChoices(account, choices) {
  const asked = config.loginChoices && choices && typeof choices === "object" ? choices : {};
  const whole = (value, max) => Number.isInteger(value) && value >= 0 && value <= max;
  // member or not, and guide or not, are the player's own choice on any
  // server; the rest only with config.loginChoices: another account type
  // shows to everyone.
  const own = choices && typeof choices === "object" ? choices : {};
  const type = MEMBERSHIP_TYPES.includes(own.accountType) ? own.accountType : asked.accountType;
  account.accountType = whole(type, MAX_ACCOUNT_TYPE) ? type : config.defaultAccountType;
  account.isGuide = own.isGuide === true;
  account.isModerator = asked.isModerator === true;
  account.membershipDays = whole(asked.membershipDays, MAX_MEMBERSHIP_DAYS) ? asked.membershipDays : DEFAULT_MEMBERSHIP_DAYS;
  // where to start is the player's to say on any server: their own den in
  // place of the township (the custom client's "Start in your own den").
  account.startInDen = Boolean(choices && typeof choices === "object" && choices.startInDen === true);
  // ... or a room or den by name ("denf", "jamaa_township.room_main");
  // lib/world.js checks that there is such a place.
  const room = choices && typeof choices === "object" ? choices.startRoom : null;
  account.startRoom = typeof room === "string" && room.length <= MAX_START_ROOM && !room.includes("%") ? room.trim() : "";
}

const stateJson = account => JSON.stringify(Object.fromEntries(Object.entries(account)
  .filter(([field]) => !COLUMN_FIELDS.includes(field) && !SESSION_FIELDS.includes(field))));

const remember = account => {
  byKey.set(account.username.toLowerCase(), account);
  byId.set(account.id, account);
};

const insert = (username, salt, hash, createdAt, state) => {
  const account = normalize({username, salt, hash, createdAt, ...state});
  const json = stateJson(account);
  const result = db.prepare("INSERT INTO accounts (username, username_key, password_salt, password_hash, created_at, state) VALUES (?, ?, ?, ?, ?, ?)")
    .run(username, username.toLowerCase(), salt, hash, createdAt, json);
  account.id = Number(result.lastInsertRowid);
  savedState.set(account.id, json);
  remember(account);
  touch(account);
  return account;
};

// one-time import of the accounts.json file earlier versions kept.
const importLegacyFile = () => {
  const file = path.join(config.dataDir, "accounts.json");
  if (!fs.existsSync(file) || db.prepare("SELECT COUNT(*) AS count FROM accounts").get().count > 0) {
    return;
  }
  const legacy = JSON.parse(fs.readFileSync(file, "utf8"));
  db.exec("BEGIN");
  for (const old of Object.values(legacy.accounts)) {
    const {id, username, salt, hash, createdAt, ...state} = old;
    if (!byKey.has(username.trim().toLowerCase())) {
      insert(username.trim(), salt, hash, createdAt || now(), state);
    }
  }
  for (const [token, usernameKey] of Object.entries(legacy.tokens || {})) {
    const account = byKey.get(usernameKey.trim());
    if (account) {
      db.prepare("INSERT INTO tokens (token, account_id, created_at) VALUES (?, ?, ?)").run(token, account.id, now());
    }
  }
  db.exec("COMMIT");
  fs.renameSync(file, `${file}.imported`);
  console.log(`[accounts] imported ${byKey.size} accounts from accounts.json`);
};

const load = () => {
  fs.mkdirSync(config.dataDir, {recursive: true});
  db = new DatabaseSync(path.join(config.dataDir, "game.sqlite"));
  // busy_timeout: something else writing to the file for a moment (a tool,
  // a copy being made) is waited for, not an error.
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  db.exec(SCHEMA);
  for (const row of db.prepare("SELECT * FROM accounts").all()) {
    const account = normalize({
      id: row.id,
      username: row.username,
      salt: row.password_salt,
      hash: row.password_hash,
      createdAt: row.created_at,
      ...JSON.parse(row.state),
    });
    savedState.set(account.id, row.state);
    remember(account);
  }
  importLegacyFile();
  db.prepare("DELETE FROM retired_names WHERE until < ?").run(now());
  for (const row of db.prepare("SELECT name_key, until FROM retired_names").all()) {
    retired.set(row.name_key, row.until);
  }
  // trade offers left on an account name who made them by account id
  // (lib/trades.js). ones from before that named a username: the id is
  // filled in, and an offer by nobody still here is dropped.
  for (const account of byId.values()) {
    for (const offer of account.tradeOffers) {
      if (offer.fromId === undefined) {
        const maker = byKey.get(String(offer.from));
        offer.fromId = maker ? maker.id : 0;
      }
    }
    account.tradeOffers = account.tradeOffers.filter(offer => byId.has(offer.fromId));
  }
  // accounts made before some names were set aside keep theirs; whoever
  // runs the server is told which, to rename by hand if they see fit.
  const unusual = [...byId.values()].filter(account => names.refused(account.username)).map(account => account.username);
  if (unusual.length) {
    console.log(`[accounts] usernames that could not be chosen today: ${unusual.slice(0, 50).join(", ")}${unusual.length > 50 ? ", ..." : ""}`);
  }
  // once: the Early Member badge for the accounts that were there before
  // it existed, the oldest hundred of them.
  if (!setting(EARLY_SETTING)) {
    const oldest = [...byId.values()].sort((one, other) => one.createdAt - other.createdAt || one.id - other.id).slice(0, EARLY_MEMBERS);
    for (const account of oldest) {
      if (!account.badges.includes(EARLY_BADGE)) {
        account.badges.push(EARLY_BADGE);
      }
    }
    flush();
    setSetting(EARLY_SETTING, "1");
  }
  // tokens stored as issued by earlier versions are replaced by their hashes.
  const rehash = db.prepare("UPDATE tokens SET token = ? WHERE token = ?");
  for (const row of db.prepare("SELECT token FROM tokens WHERE length(token) = ?").all(TOKEN_HEX_LENGTH)) {
    rehash.run(tokenHash(row.token), row.token);
  }
  db.prepare("DELETE FROM tokens WHERE created_at < ?").run(now() - config.tokenLifetimeDays * 86400);
  for (const row of db.prepare("SELECT token, account_id, created_at FROM tokens").all()) {
    tokens.set(row.token, {id: row.account_id, createdAt: row.created_at});
  }
  console.log(`[accounts] ${byKey.size} accounts in ${path.join(config.dataDir, "game.sqlite")}`);
};

// Which accounts a save looks at. turning an account into JSON to see
// whether it changed costs (up to a millisecond for a big one), and doing it
// a second after nearly every message for every account in play (online
// ones, and the buddies, dens and cards they had looked up lately) held the
// whole server up for most of every second once there were enough players.
// so game code says which accounts it changed, save(account, ...), and those
// are written within SAVE_DELAY_MS. behind them, for whatever changed an
// account without saying so, the accounts in play are looked at a few at a
// time (PLAY_BUDGET_MS a save), round and round: online ones (hold, from
// lib/world.js) and ones looked up lately (by name, id, token, password: how
// the admin panel, buddies and the like get at an offline account), for
// WARM_MS. behind those every other account is looked at the same way
// (SWEEP_BUDGET_MS), for what reached an account some other way
// (accounts.all()). a stop of the server, and every flush() called by name,
// looks at all of them.
const WARM_MS = 10 * 60 * 1000;
const PLAY_BUDGET_MS = 10;
const SWEEP_BUDGET_MS = 5;
const held = new Set(); // accounts online
const warm = new Map(); // account -> when last looked up
const dirty = new Set(); // accounts said to have changed since the last save
let playOrder = [];
let playAt = 0;
let playLeft = 0; // accounts in play still to be looked at since the last save()
let sweepOrder = [];
let sweepAt = 0;
let sweepLeft = 0; // accounts the sweep still has to look at since the last save()
const touch = account => {
  if (account) {
    warm.set(account, Date.now());
  }
  return account;
};
const hold = account => {
  held.add(account);
  touch(account);
};
const release = account => {
  held.delete(account);
  touch(account);
};

const changedState = (account, changed) => {
  const json = stateJson(account);
  if (savedState.get(account.id) !== json) {
    changed.push([account.id, json]);
    return true;
  }
  return false;
};

const elapsedMs = started => Number(process.hrtime.bigint() - started) / 1e6;

// the next accounts in play, while there is time: the ones online and the
// ones looked up lately. one looked up longer ago than WARM_MS is looked at
// once more, then left to the sweep.
const lookAtPlay = (changed, looked) => {
  const started = process.hrtime.bigint();
  while (playLeft > 0 && elapsedMs(started) < PLAY_BUDGET_MS) {
    if (playAt >= playOrder.length) {
      const now = Date.now();
      playOrder = [...new Set([...held, ...warm.keys()])];
      playAt = 0;
      for (const [account, at] of warm) {
        if (now - at > WARM_MS && !held.has(account)) {
          warm.delete(account);
        }
      }
      if (playOrder.length === 0) {
        playLeft = 0;
        break;
      }
    }
    const account = playOrder[playAt++];
    playLeft--;
    if (!looked.has(account) && byId.get(account.id) === account) {
      looked.add(account);
      changedState(account, changed);
    }
  }
};

const lookAtRest = (changed, looked) => {
  const started = process.hrtime.bigint();
  while (sweepLeft > 0 && elapsedMs(started) < SWEEP_BUDGET_MS) {
    if (sweepAt >= sweepOrder.length) {
      sweepOrder = [...byId.values()];
      sweepAt = 0;
      if (sweepOrder.length === 0) {
        sweepLeft = 0;
        break;
      }
    }
    const account = sweepOrder[sweepAt++];
    sweepLeft--;
    if (!looked.has(account) && byId.get(account.id) === account) {
      looked.add(account);
      changedState(account, changed);
    }
  }
};

// writes every account whose state changed since it was last written, in
// one transaction; with {some: true}, of the accounts said to have changed
// and the next few of the others (above).
const flush = ({some = false} = {}) => {
  clearTimeout(saveTimer);
  saveTimer = null;
  if (!db) {
    return;
  }
  const changed = [];
  const named = [...dirty];
  dirty.clear();
  if (some) {
    const looked = new Set();
    for (const account of named) {
      if (byId.get(account.id) === account) {
        looked.add(account);
        changedState(account, changed);
      }
    }
    lookAtPlay(changed, looked);
    lookAtRest(changed, looked);
  }
  else {
    for (const account of byId.values()) {
      changedState(account, changed);
    }
    playLeft = 0;
    sweepLeft = 0;
  }
  if (playLeft > 0 || sweepLeft > 0) {
    later(CONTINUE_MS); // the looking goes on in a moment
  }
  if (changed.length === 0) {
    return;
  }
  const update = db.prepare("UPDATE accounts SET state = ? WHERE id = ?");
  db.exec("BEGIN");
  try {
    for (const [id, json] of changed) {
      update.run(json, id);
    }
    db.exec("COMMIT");
  }
  catch (err) {
    db.exec("ROLLBACK");
    named.forEach(account => dirty.add(account));
    throw err;
  }
  for (const [id, json] of changed) {
    savedState.set(id, json);
  }
};

// "Something changed": the accounts named are written within SAVE_DELAY_MS,
// and the looking-through above starts again. game code calls this after
// nearly every message (and some of it a hundred times in a row), so it is
// done once for all the calls of a moment. what a crash can lose is that
// moment, for an account named, and the time a round of the looking takes,
// for one changed without saying so; a stop of the server writes first
// (server.js).
const SAVE_DELAY_MS = 1000;
const CONTINUE_MS = 250;
let saveTimer = null;
const later = delay => {
  if (saveTimer === null) {
    saveTimer = setTimeout(() => {
      try {
        flush({some: true});
      }
      catch (err) {
        console.error(`[accounts] could not save: ${err.message}`);
        save(); // tried again in a moment: nothing is lost while the server runs
      }
    }, delay);
  }
};
const save = (...changedAccounts) => {
  for (const account of changedAccounts) {
    if (account) {
      dirty.add(account);
    }
  }
  playLeft = held.size + warm.size;
  sweepLeft = byId.size;
  later(SAVE_DELAY_MS);
};

// A copy of the whole database, made once a day into data/backups/ and the
// latest BACKUPS_KEPT kept. it is a whole file of its own, to be copied
// somewhere else by whoever runs the server: a copy on the same disk is no
// help when the disk goes. it is copied a batch of pages at a time off the
// main thread (sqlite's online backup): made in one go (VACUUM INTO, after
// writing every account) it held the game up for seconds.
const BACKUPS_KEPT = 14;
let backingUp = false;
const backup = async () => {
  const folder = path.join(config.dataDir, "backups");
  const file = path.join(folder, `game-${new Date().toISOString().slice(0, 10)}.sqlite`);
  if (backingUp || fs.existsSync(file)) {
    return;
  }
  backingUp = true;
  const part = `${file}.part`;
  try {
    fs.mkdirSync(folder, {recursive: true, mode: 0o700});
    fs.rmSync(part, {force: true});
    await copyDatabase(db, part);
    fs.chmodSync(part, 0o600);
    fs.renameSync(part, file); // only a whole copy has the day's name
  }
  finally {
    backingUp = false;
    fs.rmSync(part, {force: true});
  }
  const old = fs.readdirSync(folder).filter(name => /^game-\d{4}-\d{2}-\d{2}\.sqlite$/.test(name)).sort().slice(0, -BACKUPS_KEPT);
  for (const name of old) {
    fs.unlinkSync(path.join(folder, name));
  }
  console.log(`[accounts] backup written: ${file}`);
};
const startBackups = () => {
  const attempt = () => {
    backup().catch(err => {
      console.error(`[accounts] backup failed: ${err.message}`);
    });
  };
  attempt();
  setInterval(attempt, 3600000).unref();
};

const usernameProblem = username => {
  if (typeof username !== "string" || !USERNAME_PATTERN.test(username) || username !== username.trim() || /\s{2,}/.test(username)
    || (username.match(/[A-Za-z]/g) || []).length < MIN_LETTERS) {
    return "invalid_username";
  }
  if (byKey.has(username.toLowerCase()) || (retired.get(username.toLowerCase()) || 0) > now()) {
    return "username_taken";
  }
  // staff-like names and slurs (lib/names.js).
  return names.refused(username) ? "name_not_allowed" : null;
};

const retire = key => {
  const until = now() + NAME_HELD_DAYS * 86400;
  retired.set(key, until);
  db.prepare("INSERT INTO retired_names (name_key, until) VALUES (?, ?) ON CONFLICT(name_key) DO UPDATE SET until = excluded.until").run(key, until);
};

// A new password: ten characters or more, with a capital letter, a small
// one and a digit among them. passwords chosen before this rule still sign
// in; it is asked of the next one.
const passwordProblem = password =>
  (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH || password.length > MAX_PASSWORD_LENGTH
    || !/[A-Z]/.test(password) || !/[a-z]/.test(password) || !/[0-9]/.test(password) ? "invalid_password" : null);

// creates an account. `avatar` gives the first animal's {type, name}; the
// name may be left out, and is then the player's. there is no default
// animal: whoever signs up picks one.
// returns {account} or {error: "invalid_username" | "username_taken" |
// "invalid_password" | "choose_animal"}.
const register = (username, password, avatar = {}) => {
  username = typeof username === "string" ? username.trim() : username;
  const error = usernameProblem(username) || passwordProblem(password) || (defpacks.avatarDef(avatar.type) ? null : "choose_animal");
  if (error) {
    return {error};
  }
  const type = Number(avatar.type);
  const salt = crypto.randomBytes(16).toString("hex");
  const account = insert(username, salt, hashPassword(password, salt), now(), {
    avatars: [newAvatar({perUserAvId: 1, avInvId: 1}, avatar.name || username, type, -1)],
    activeAvatar: 1,
    // early Member, for an account made while there are no more than a hundred.
    badges: byId.size < EARLY_MEMBERS ? [EARLY_BADGE] : [],
  });
  console.log(`[accounts] registered "${username}" (id ${account.id})`);
  return {account};
};

const authenticate = (username, password) => {
  // "name" and "name " are the same account.
  const account = typeof username === "string" ? touch(byKey.get(username.trim().toLowerCase())) : null;
  if (typeof password !== "string" || !password) {
    return null;
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    return null;
  }
  if (!account) {
    // throwaway test accounts (AJ_REGISTER=1) are the one sign-up with no
    // choice of animal to make.
    if (config.registerOnLogin) {
      return register(username, password, {type: defpacks.defaultAvatarType()}).account || null;
    }
    hashPassword(password, NOBODY_SALT);
    return null;
  }
  const hash = Buffer.from(hashPassword(password, account.salt), "hex");
  return crypto.timingSafeEqual(hash, Buffer.from(account.hash, "hex")) ? account : null;
};

// the same, with the password worked out off the main thread (above).
const authenticateAsync = async (username, password) => {
  const account = typeof username === "string" ? touch(byKey.get(username.trim().toLowerCase())) : null;
  if (typeof password !== "string" || !password || password.length > MAX_PASSWORD_LENGTH) {
    return null;
  }
  if (!account) {
    if (config.registerOnLogin) {
      return register(username, password, {type: defpacks.defaultAvatarType()}).account || null;
    }
    await hashPasswordAsync(password, NOBODY_SALT);
    return null;
  }
  const {salt, hash: stored} = account;
  const hash = Buffer.from(await hashPasswordAsync(password, salt), "hex");
  // the account may have gone, or got a new password, in the meantime.
  return byId.get(account.id) === account && account.hash === stored && crypto.timingSafeEqual(hash, Buffer.from(stored, "hex")) ? account : null;
};

// gives the account a new password and signs it out everywhere. returns
// "invalid_password" when the password is not acceptable, else null.
const setPassword = (account, password) => {
  const problem = passwordProblem(password);
  if (problem) {
    return problem;
  }
  account.salt = crypto.randomBytes(16).toString("hex");
  account.hash = hashPassword(password, account.salt);
  db.prepare("UPDATE accounts SET password_salt = ?, password_hash = ? WHERE id = ?").run(account.salt, account.hash, account.id);
  revokeTokens(account);
  account.devices = []; // every device gives its two-step code again (lib/totp.js)
  flush();
  return null;
};

// the only limits on a username the admin sets by hand: it has to be storable
// and able to reach the game at all. the database needs some text and a name
// nobody else has; "%" and control characters cannot travel through the game
// protocol ("%" separates its fields), so such a name could never log in.
// MAX_STORED_USERNAME is a sanity cap, not a rule of the game.
const MAX_STORED_USERNAME = 100;
const storableUsernameProblem = username => {
  if (typeof username !== "string" || username.length === 0 || username.length > MAX_STORED_USERNAME
    || /[%\u0000-\u001f\u007f]/.test(username) || username.includes("]]>")) {
    return "invalid_username";
  }
  return byKey.has(username.toLowerCase()) ? "username_taken" : null;
};

// gives the account a new username, and carries it into everyone's buddy and
// block lists. returns "invalid_username" or "username_taken", else null.
// the player must not be online: the game knows them by the old name.
// with `anyName` (the admin panel) the sign-up rules about length and
// characters do not apply; see storableUsernameProblem.
const rename = (account, username, anyName = false) => {
  // spaces around a name are dropped: logging in drops them too.
  username = typeof username === "string" ? username.trim() : username;
  const oldKey = account.username.toLowerCase();
  // only changing the capitals of one's own name is not "taken".
  const problem = typeof username === "string" && username.toLowerCase() === oldKey && username !== account.username
    ? null : (anyName ? storableUsernameProblem : usernameProblem)(username);
  if (problem) {
    return problem;
  }
  const newKey = username.toLowerCase();
  if (newKey !== oldKey) {
    retire(oldKey);
    retired.delete(newKey); // the admin gave out a held name
    db.prepare("DELETE FROM retired_names WHERE name_key = ?").run(newKey);
  }
  db.prepare("UPDATE accounts SET username = ?, username_key = ? WHERE id = ?").run(username, newKey, account.id);
  console.log(`[accounts] renamed "${account.username}" to "${username}" (id ${account.id})`);
  byKey.delete(oldKey);
  account.username = username;
  byKey.set(newKey, account);
  const named = [account];
  for (const other of byId.values()) {
    if ([other.buddies, other.blocked, other.buddyRequests].some(list => list.includes(oldKey))) {
      other.buddies = other.buddies.map(name => (name === oldKey ? newKey : name));
      other.blocked = other.blocked.map(name => (name === oldKey ? newKey : name));
      other.buddyRequests = other.buddyRequests.map(name => (name === oldKey ? newKey : name));
      named.push(other);
    }
  }
  save(...named);
  return null;
};

// is this part of the game switched on for the account (FEATURES)?
const featureOn = (account, name) => account.features[name] !== false;

// notes a sign-in, or a wrong password, in the account's own history.
// `via` is "game" (the game itself connecting), "launcher" (signing in to
// play) or "web" (the account page). the caller saves.
const recordLogin = (account, via, address, ok = true) => {
  account.logins.unshift({at: now(), via, address: String(address || "").replace(/^::ffff:/, "").slice(0, 60), ok});
  account.logins = account.logins.filter(login => login.at > now() - LOGIN_DAYS_KEPT * 86400).slice(0, MAX_LOGINS_KEPT);
};

const revokeTokens = account => {
  db.prepare("DELETE FROM tokens WHERE account_id = ?").run(account.id);
  for (const [hash, entry] of tokens) {
    if (entry.id === account.id) {
      tokens.delete(hash);
    }
  }
};

// deletes the account for good, and its name from everyone's buddy and
// block lists.
const remove = account => {
  const key = account.username.toLowerCase();
  revokeTokens(account);
  db.prepare("DELETE FROM accounts WHERE id = ?").run(account.id);
  byKey.delete(key);
  byId.delete(account.id);
  savedState.delete(account.id);
  retire(key);
  const named = [];
  for (const other of byId.values()) {
    if (other.tradeOffers.some(offer => offer.fromId === account.id)
      || [other.buddies, other.blocked, other.buddyRequests].some(list => list.includes(key))) {
      other.tradeOffers = other.tradeOffers.filter(offer => offer.fromId !== account.id);
      other.buddies = other.buddies.filter(name => name !== key);
      other.blocked = other.blocked.filter(name => name !== key);
      other.buddyRequests = other.buddyRequests.filter(name => name !== key);
      named.push(other);
    }
  }
  save(...named);
  console.log(`[accounts] deleted "${account.username}" (id ${account.id})`);
};

// small server-wide values kept in the database (the admin panel's password).
const setting = key => {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key);
  return row ? row.value : null;
};

const setSetting = (key, value) => {
  db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
};

// one token serves as both auth_token and refresh_token. it stops working
// after config.tokenLifetimeDays, and each account keeps only its newest few.
const issueToken = account => {
  const token = crypto.randomBytes(TOKEN_HEX_LENGTH / 2).toString("hex");
  const hash = tokenHash(token);
  const createdAt = now();
  db.prepare("INSERT INTO tokens (token, account_id, created_at) VALUES (?, ?, ?)").run(hash, account.id, createdAt);
  tokens.set(hash, {id: account.id, createdAt});
  const mine = [...tokens].filter(([, entry]) => entry.id === account.id).sort((a, b) => b[1].createdAt - a[1].createdAt);
  for (const [oldHash] of mine.slice(MAX_TOKENS_PER_ACCOUNT)) {
    db.prepare("DELETE FROM tokens WHERE token = ?").run(oldHash);
    tokens.delete(oldHash);
  }
  return token;
};

const byToken = token => {
  const entry = typeof token === "string" && token.length === TOKEN_HEX_LENGTH ? tokens.get(tokenHash(token)) : null;
  return entry && !tokenExpired(entry.createdAt) ? touch(byId.get(entry.id)) || null : null;
};

const byName = username => touch(byKey.get(String(username).toLowerCase())) || null;

const accountById = id => touch(byId.get(Number(id))) || null;

const all = () => [...byId.values()];

const database = () => db;

module.exports = {FEATURES, featureOn, recordLogin, revokeTokens, load, save, flush, hold, release, startBackups, database, setLoginChoices, setPassword, rename, remove, setting, setSetting, hashPassword, register, usernameProblem, authenticate, authenticateAsync, issueToken, byToken, byName, byId: accountById, newAvatar, freeAvatarSlot, all};
