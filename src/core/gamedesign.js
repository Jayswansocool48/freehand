'use strict';
/*
 * Game design briefs. A small model given "make a 3d rust like game" writes whatever game it knows
 * (a coin collector) because it never works out what Rust is. Before planning, Freehand turns the
 * request into a brief: the core loop and the features that make it that kind of game, each with the
 * recipe that builds it and a check that finds it in game.js. The finish check uses the same list,
 * so a game that is missing what was asked for is not called done.
 */

// What each feature is, the recipe that builds it (if any) and how to spot it in game.js.
const FEATURES = {
  gather: { what: 'gather wood and stone by hitting trees and rocks', recipe: 'gather', check: /\bNODES\b|\binv\.(wood|stone)\b/ },
  craft: { what: 'craft tools from what you gathered', recipe: 'craft', check: /\btools\.\w+|craft/i },
  build: { what: 'build walls or a base from your materials', recipe: 'build', check: /placeWall|build/i },
  hunger: { what: 'health and hunger that run down; eat to survive', recipe: 'hunger', check: /hunger|stats\.health/i },
  daynight: { what: 'a day and night cycle; night is more dangerous', recipe: 'daynight', check: /g\.night|daynight|DAY\b/ },
  enemies: { what: 'enemies that chase and hurt the player', recipe: 'chaser', check: /chase|enem/i },
  shooting: { what: 'shoot at enemies', recipe: 'shooting', check: /shoot|bullet|fire/i },
  lives: { what: 'lives or health, so mistakes cost something', recipe: 'lives', check: /lives|health|hurt\(/i },
  coins: { what: 'things to collect that score', recipe: 'coins', check: /coin|collect|gem/i },
  platforms: { what: 'platforms to jump across, some moving', recipe: 'moving_platforms', check: /platform/i },
  timer: { what: 'a time limit', recipe: 'timer', check: /timer|timeLeft|countdown/i },
  levels: { what: 'difficulty that rises as you play', recipe: 'levels', check: /level/i },
  scenery: { what: 'a world with scenery (trees, rocks, buildings)', recipe: 'scenery', check: /SCENERY|tree|rock|house/i },
};

// Well-known games: what playing them is like, in features Freehand can build.
const KNOWN = [
  { re: /\brust\b|\bdayz\b|\bark\b|\bvalheim\b|\bthe forest\b|\bsurviv(al|e)\b/i, name: 'a survival game like Rust', d3: true, camera: 'third',
    loop: 'start with nothing, gather wood and stone, craft better tools, build a shelter, eat to stay alive, and survive enemies at night',
    features: ['gather', 'craft', 'build', 'hunger', 'daynight', 'enemies'] },
  { re: /\bminecraft\b|\bvoxel\b|\bblock ?craft\b/i, name: 'a block-building game like Minecraft', d3: true, camera: 'third',
    loop: 'mine trees and rocks for blocks, craft tools, place blocks to build, and survive monsters that come out at night',
    features: ['gather', 'craft', 'build', 'daynight', 'enemies', 'hunger'] },
  { re: /\bfortnite\b|\bpubg\b|\bbattle ?royale\b|\bapex\b|\bwarzone\b/i, name: 'a battle royale', d3: true, camera: 'third',
    loop: 'drop into a map, find cover, shoot the other players (enemies), and build walls for cover; be the last one standing',
    features: ['shooting', 'enemies', 'build', 'gather', 'lives', 'scenery'] },
  { re: /\bdoom\b|\bcall of duty\b|\bcod\b|\bhalo\b|\bcounter[ -]?strike\b|\bfps\b|first[ -]person shooter/i, name: 'a first-person shooter', d3: true, camera: 'first',
    loop: 'move through an arena, shoot waves of enemies that come for you, and stay alive as the waves get harder',
    features: ['shooting', 'enemies', 'lives', 'levels', 'scenery'] },
  { re: /\bmario\b|\bplatform(er)?\b|\bobby\b|\bparkour\b/i, name: 'a platformer', camera: 'third',
    loop: 'run and jump across platforms, some moving, collect things on the way, and reach the goal without falling',
    features: ['platforms', 'coins', 'lives'] },
  { re: /\bzelda\b|\badventure\b|\brpg\b|\bdungeon\b/i, name: 'an action adventure', d3: true, camera: 'third',
    loop: 'explore a world, fight enemies, collect treasure and grow stronger',
    features: ['enemies', 'shooting', 'lives', 'coins', 'scenery'] },
  { re: /\bfnaf\b|five nights|\bhorror\b|\bbackrooms\b|\bscary\b/i, name: 'a horror game', d3: true, camera: 'first',
    loop: 'survive until morning in a dark place while something hunts you; manage a limited resource and hide or run',
    features: ['enemies', 'daynight', 'timer', 'lives'] },
  { re: /\bsubway surfers\b|\btemple run\b|endless runner/i, name: 'an endless runner', d3: true, camera: 'chase',
    loop: 'run forward forever, switch lanes and jump over obstacles, collect coins, and go faster over time',
    features: ['coins', 'levels', 'lives'] },
  { re: /\bgta\b|\bgrand theft\b|\bracing\b|\bracer\b|\bdriv(e|ing)\b|\bkart\b/i, name: 'a driving game', d3: true, camera: 'chase',
    loop: 'drive a car around a track or town, beat the clock and avoid crashing',
    features: ['timer', 'scenery', 'levels'] },
];

const LIKE_BEFORE = /\b(?:like|similar to|inspired by|in the style of|style of|clone of|version of)\s+(?:the game\s+)?([a-z0-9][\w' :-]{1,30}?)(?=\s+(?:but|with|where|that|and|game|in|thats?|which)\b|[.,!?]|$)/i;
const LIKE_AFTER = /\b([a-z0-9][\w'-]{1,20})[ -](?:like|style|clone)\b/i;
const NOT_A_GAME = /^(a|an|the|game|games|3d|2d|simple|small|cool|fun|something|one|it|this|that)$/i;

/** The game a request names to copy ("like Rust", "rust-like"), or ''. */
function likeGame(text) {
  const t = String(text || '');
  for (const re of [LIKE_BEFORE, LIKE_AFTER]) {
    const m = re.exec(t);
    const name = m ? m[1].trim().replace(/\s+game$/i, '') : '';
    if (name && !NOT_A_GAME.test(name)) return name;
  }
  return '';
}

const isGame = (t) => /\bgames?\b|\bplayable\b/i.test(t) || KNOWN.some((k) => k.re.test(t));

/**
 * A design brief for a game request, or null. `research` is optional text about the game the request
 * names (search snippets), used when it is not one Freehand already knows.
 */
function designBrief(text, research = '') {
  const t = String(text || '');
  if (!isGame(t)) return null;
  const known = KNOWN.find((k) => k.re.test(t));
  const like = likeGame(t);
  // Games that are 3D in real life are made 3D unless the request says 2D.
  const three = !/\b2d\b/i.test(t) && (/\b3d\b|three\.?js|first[ -]person|third[ -]person/i.test(t) || !!(known && known.d3));
  // "Simple" keeps the features that make it that game and drops the extras.
  const simple = /\b(simple|small|basic|quick|tiny|easy)\b/i.test(t);
  const features = known ? known.features.slice(0, simple ? 4 : 8) : [];
  const lines = [`Game design for "${t.trim().slice(0, 120)}":`];
  if (known) lines.push(`- This is ${known.name}. Core loop: ${known.loop}.`);
  else if (like) lines.push(`- It should play like ${like}. Work out what playing ${like} is like from what you know${research ? ' and the research below' : ''}, and build that, not a different game.`);
  if (research) lines.push(`- Research on ${like}:\n${research}`);
  if (features.length) {
    lines.push('- Features it needs, each its own plan step (use game_recipe where named):');
    for (const f of features) lines.push(`  - ${FEATURES[f].what}${FEATURES[f].recipe ? ` (game_recipe "${FEATURES[f].recipe}")` : ''}`);
  } else {
    lines.push('- List the 3 to 6 features a player of this kind of game expects, and make each one a plan step.');
  }
  lines.push(`- ${three ? `3D, built on kit3d.js with camera "${(known && known.camera) || 'third'}"` : 'Pick 2D (kit.js) or 3D (kit3d.js) to fit; 3D if it says 3D'}. Make the player and the important things with make_model so they look like what they are.`);
  lines.push('- "Simple" means fewer features done well, never a different game.');
  return { text: lines.join('\n'), features, like, three };
}

/** Features from the brief that game.js does not have yet. */
function missingFeatures(brief, gameJs) {
  if (!brief || !brief.features.length) return [];
  return brief.features.filter((f) => !FEATURES[f].check.test(gameJs)).map((f) => FEATURES[f]);
}

module.exports = { designBrief, missingFeatures, likeGame, FEATURES, KNOWN };
