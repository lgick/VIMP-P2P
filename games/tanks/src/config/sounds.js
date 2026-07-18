const sounds = {
  // https://freesound.org/people/joepayne/sounds/413201/
  roundStart: { file: 'round-start', priority: 200, volume: 0.3 },
  // https://pixabay.com/sound-effects/silly-trumpet-2-187807/
  victory: { file: 'victory', priority: 200, volume: 0.3 },
  // https://pixabay.com/sound-effects/silly-trumpet-11-187806/
  defeat: { file: 'defeat', priority: 200, volume: 0.3 },

  // https://pixabay.com/sound-effects/metal-hit-sound-effect-241374/
  frag: { file: 'frag', priority: 150, volume: 0.3 },
  // https://freesound.org/people/SamsterBirdies/sounds/581598/
  hit: { file: 'hit', priority: 150, volume: 0.3 },
  // https://freesound.org/people/obstgegenrechz/sounds/267980/
  gameOver: { file: 'game-over', priority: 150, volume: 0.3 },

  // https://freesound.org/people/GaryQ/sounds/127845/
  shot: { file: 'shot', priority: 100, volume: 0.4 },
  // https://freesound.org/people/studiomandragore/sounds/401628/
  explosion: { file: 'explosion', priority: 100, volume: 0.4 },
  // https://pixabay.com/sound-effects/start-stop-stopwatch-364924/
  // https://freesound.org/people/vibe_crc/sounds/47988/
  bombHasBeenPlanted: {
    file: 'bomb-has-been-planted',
    priority: 90,
    volume: 0.4,
  },

  // https://freesound.org/people/monosfera/sounds/572294/
  tankEngine: { file: 'tank-engine', priority: 50, loop: true, volume: 0.5 },
};

export default {
  codecList: ['webm', 'mp3'],
  path: '/sounds/',
  sounds,
};
