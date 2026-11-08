const adjectives = 'Cosmic Wobbly Disco Sneaky Bouncy Galactic Crispy Dizzy Fuzzy Noodle Groovy Sleepy Spicy Jolly Loopy Squishy Turbo Giggly Velvet Soggy Zippy Fluffy Moonwalking Wiggly Fizzy Snazzy Goofy Jazzy Tiny Chunky Dapper Wacky'.split(' ');
const nouns = 'Wombat Pickle Pancake Badger Potato Narwhal Noodle Goblin Otter Turnip Hamster Comet Dumpling Goose Biscuit Llama Muffin Squid Raccoon Toaster Waffle Penguin Yeti Pudding Walrus Taco Jellybean Platypus Sloth Cactus Donut Mongoose'.split(' ');

/** Shared anonymous names, stable across video exports, profiles, and filtering. */
export function projectAliases(count: number, random?: () => number) {
  let seed = 0x534752;
  const next = random ?? (() => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; });
  const pairs = adjectives.flatMap(adjective => nouns.map(noun => `${adjective} ${noun}`));
  for (let i = pairs.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1)); [pairs[i], pairs[j]] = [pairs[j], pairs[i]];
  }
  return Array.from({ length: count }, (_, index) => `Project ${'Mega'.repeat(Math.floor(index / pairs.length))}${pairs[index % pairs.length]}`);
}
