'use strict';

/*
 * Named model profiles: several endpoint/model/key combos the user can switch
 * between from the panel menu (e.g. "local llama.cpp" vs "intranet big model").
 * Storage lives in globalState via runtime.js; this module only holds the pure
 * list operations so they can be audited without VS Code.
 */

const MAX_PROFILES = 8;
const MAX_NAME_CHARS = 24;

/* Keep valid entries, trim noise, cap the list. A profile without a name or
 * without any endpoint info is useless and is dropped. */
function normalizeProfiles(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const items = [];
  const seen = {};
  list.forEach(function (p) {
    if (!p || typeof p !== 'object') { return; }
    const name = String(p.name || '').trim().slice(0, MAX_NAME_CHARS);
    const baseUrl = String(p.baseUrl || '').trim().replace(/\/+$/, '');
    if (!name || seen[name.toLowerCase()]) { return; }
    if (!baseUrl && !String(p.model || '').trim()) { return; }
    seen[name.toLowerCase()] = true;
    items.push({
      name: name,
      baseUrl: baseUrl,
      model: String(p.model || '').trim().slice(0, 120),
      key: typeof p.key === 'string' ? p.key : '',
      at: Number(p.at) || 0
    });
  });
  return items.slice(0, MAX_PROFILES);
}

/* The active profile is the one whose endpoint+model match the live settings.
 * Matching is exact on both so a half-changed state is reported as "custom". */
function findActive(profiles, baseUrl, model) {
  const b = String(baseUrl || '').replace(/\/+$/, '');
  const m = String(model || '').trim();
  for (let i = 0; i < profiles.length; i++) {
    if (profiles[i].baseUrl === b && profiles[i].model === m) { return profiles[i].name; }
  }
  return '';
}

function addProfile(profiles, entry) {
  const fresh = normalizeProfiles(profiles.concat([entry]));
  if (fresh.length === normalizeProfiles(profiles).length &&
      !fresh.some(function (p) { return p.name === String(entry && entry.name || '').trim().slice(0, MAX_NAME_CHARS); })) {
    return { ok: false, message: '配置已存在或信息不完整', list: profiles };
  }
  if (profiles.length >= MAX_PROFILES && fresh.length > MAX_PROFILES - 0) {
    return { ok: false, message: '配置数量已达上限 ' + MAX_PROFILES + ' 个，请先删除一个', list: profiles };
  }
  return { ok: true, list: fresh };
}

function deleteProfile(profiles, name) {
  const target = String(name || '').trim().toLowerCase();
  const next = profiles.filter(function (p) { return p.name.toLowerCase() !== target; });
  if (next.length === profiles.length) { return { ok: false, list: profiles }; }
  return { ok: true, list: next };
}

module.exports = {
  normalizeProfiles,
  findActive,
  addProfile,
  deleteProfile,
  MAX_PROFILES,
  MAX_NAME_CHARS
};
