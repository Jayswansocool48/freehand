'use strict';
/*
 * Picks the game kit template for a request like "make flappy bird", so a new game starts from
 * working code before the model makes any choice. Small models often skip game_template and
 * write a broken game from scratch; this takes that choice away from them.
 */

// Checked in order: the first match wins, so specific genres come before broad ones.
const GENRES = [
  ['flyer', /\bflapp|\bflap\b|tap to fly|helicopter game|fly through (the )?(pipes|gaps)/i],
  ['snake', /\bsnake\b|\bnibbles\b/i],
  ['breakout', /\bbreakout\b|\barkanoid\b|brick ?break|\bbricks?\b.*\b(ball|paddle)\b|\bpaddle\b.*\bbricks?\b/i],
  ['shooter', /\bshoot(er|ing|\s?'?em)\b|space invaders|\bgalaga\b|\basteroids\b|bullet hell|\bshmup\b/i],
  ['runner', /\b(endless|infinite|auto)[ -]?run|\brunner\b|dino (game|run)/i],
  ['3d', /\b3d\b|three\.?js|first[ -]person|third[ -]person|low[ -]poly/i],
  ['platformer', /\bplatform(er|ing)?\b|side[ -]?scroll|\bmario\b|jump (on|between|across)/i],
  ['topdown', /top[ -]?down|\bdodge\b|\barena\b|bullet|\bsurviv(e|al)\b|\bmaze\b|\bzelda\b/i],
];

const MAKE = /\b(make|build|create|write|code|program|design|develop|give me|i want|can you do)\b/i;
const NAMED_GAME = /\b(flappy|snake|breakout|arkanoid|space invaders|galaga|asteroids|platformer|shooter|shmup|runner)\b/i;

/** The template for a request that asks for a new game, or null. */
function templateFor(text) {
  const t = String(text || '');
  if (!MAKE.test(t) && !/^\s*(a |an )?\w+( \w+)? game\s*$/i.test(t)) return null;
  if (!/\bgames?\b/i.test(t) && !NAMED_GAME.test(t)) return null;
  for (const [kind, re] of GENRES) if (re.test(t)) return kind;
  return null;
}

/** "make me a flappy bird game with cats" -> "Flappy Bird". */
function gameTitle(text) {
  let t = String(text || '').split(/[.!?\n]/)[0];
  t = t.replace(/^.*?\b(make|build|create|write|code|program|design|develop|give me|i want|can you do)\b\s*(me\s+)?((an|a|the|my|some)\b)?\s*/i, '');
  t = t.split(/\s+(where|with|that|which|in which|for|using|like|but|and then)\s+/i)[0];
  t = t.replace(/\b(simple|small|little|basic|quick|cool|fun|new)\b\s*/gi, '').replace(/\bgame\b/gi, '').replace(/[^\w' -]/g, '').trim();
  if (!t) return 'My Game';
  return t.split(/\s+/).slice(0, 5).map((w) => (/^\dd$/i.test(w) ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1))).join(' ');
}

module.exports = { templateFor, gameTitle, GENRES };
