'use strict';

// Who a case is for comes from MemberManager's list (ab-common's members.js):
// a member, as FormTracker sees them (each member household's head, with a
// Member ID), or an organization such as a church. A case keeps the record's
// id and its name as it was; the name shown is the list's current one,
// following MemberManager's merges, so a rename there shows here too.

const { memberListFolder, readMemberList, members, currentId } = require('ab-common/members');

const norm = (s) => String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();

/** MemberManager's list for whoever is signed in, as people to choose from, or null when it can't be read. */
function loadDirectory(identity) {
  const folder = memberListFolder(identity);
  const list = folder ? readMemberList(folder) : null;
  if (!list) return null;
  const people = members(list).map((m) => ({
    kind: 'contact',
    id: m.id,
    memberId: m.memberId,
    name: m.name,
    detail: [m.memberId && `Member ${m.memberId}`, m.orgName, [m.city, m.state].filter(Boolean).join(', ')].filter(Boolean).join(' · '),
  }));
  const orgs = list.orgs.filter((o) => o.name).map((o) => ({
    kind: 'org',
    id: o.id,
    memberId: '',
    name: o.name,
    detail: ['Organization', [o.city, o.state].filter(Boolean).join(', ')].filter(Boolean).join(' · '),
  }));
  const byKey = new Map([...people, ...orgs].map((r) => [`${r.kind}:${r.id}`, r]));
  return { folder, list, entries: [...people, ...orgs], byKey };
}

/** Up to `limit` people and organizations matching every word of `query`. */
function search(directory, query, limit = 30) {
  if (!directory) return [];
  const words = norm(query).split(' ').filter(Boolean);
  if (!words.length) return [];
  return directory.entries
    .filter((r) => {
      const hay = norm(`${r.name} ${r.memberId} ${r.detail}`);
      return words.every((w) => hay.includes(w));
    })
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, limit);
}

/**
 * How a case's recipient shows: { name, detail, missing }, `missing` when
 * MemberManager's list no longer has them (deleted there), in which case
 * the name the case kept is shown.
 */
function describeRecipient(directory, recipient) {
  const kept = { name: recipient.name, detail: recipient.memberId ? `Member ${recipient.memberId}` : '', missing: false };
  if (recipient.kind === 'none' || !directory) return kept;
  const id = currentId(directory.list, recipient.kind, recipient.id);
  const entry = id && directory.byKey.get(`${recipient.kind}:${id}`);
  return entry ? { name: entry.name, detail: entry.detail, missing: false } : { ...kept, missing: true };
}

/** The recipient as one line, for the reminder email: "Ann Miller (Member 1234)". */
function recipientLine(directory, recipient) {
  const { name } = describeRecipient(directory, recipient);
  return recipient.memberId ? `${name} (Member ${recipient.memberId})` : name;
}

module.exports = { loadDirectory, search, describeRecipient, recipientLine };
