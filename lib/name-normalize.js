'use strict';

const TITLES = new Set(['mr', 'mrs', 'ms', 'miss', 'dr', 'prof', 'sir', 'madam', 'madame']);
const SUFFIXES = new Set(['jr', 'sr', 'ii', 'iii', 'iv', 'esq', 'phd', 'md']);

function stripDiacritics(str) {
  return str.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

function replacePunctuation(str) {
  const stripped = str.replace(/['‘’ʼ`]/g, '');
  return stripped.replace(/[.,\-"_/()&+!?;:*]/g, ' ');
}

function collapseWhitespace(str) {
  return str.replace(/\s+/g, ' ').trim();
}

function isInitial(token) {
  return token.length === 1 && /^[a-z]$/.test(token);
}

function handleCommaReversal(raw) {
  const firstComma = raw.indexOf(',');
  if (firstComma === -1) return raw;
  const left = raw.slice(0, firstComma).trim();
  const right = raw.slice(firstComma + 1).trim();
  if (!left || !right) return raw;
  return `${right} ${left}`;
}

function normalize(rawInput) {
  const empty = { normalized_name: null, name_token_set: null };
  if (rawInput === null || rawInput === undefined) return empty;
  const raw = String(rawInput);
  if (!raw.trim()) return empty;

  const reordered = handleCommaReversal(raw);
  let s = reordered.normalize('NFC');
  s = stripDiacritics(s);
  s = s.toLowerCase();
  s = replacePunctuation(s);
  s = collapseWhitespace(s);
  if (!s) return empty;

  const tokens = s.split(' ')
    .filter(Boolean)
    .filter(t => !TITLES.has(t))
    .filter(t => !SUFFIXES.has(t))
    .filter(t => !isInitial(t));

  if (tokens.length === 0) return empty;

  const normalized_name = tokens.join(' ');
  const name_token_set = [...tokens].sort().join(' ');
  return { normalized_name, name_token_set };
}

function normalizePhone(rawInput) {
  if (rawInput === null || rawInput === undefined) return null;
  const digits = String(rawInput).replace(/\D/g, '');
  if (digits.length < 7) return null;
  return digits.slice(-10);
}

module.exports = { normalize, normalizePhone };
